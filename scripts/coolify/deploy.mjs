#!/usr/bin/env node
/**
 * Despliegue del stack en Coolify por API — Coolify es EFÍMERO: nada se
 * configura a mano en su UI. Lo ejecuta .github/workflows/deploy.yml con las
 * variables tomadas de los Secrets del repo.
 *
 *   node scripts/coolify/deploy.mjs bootstrap  # crea el recurso (Coolify nuevo)
 *   node scripts/coolify/deploy.mjs deploy     # sincroniza envs+dominios y despliega
 *
 * Endpoints idénticos a los que ya usa tdp-gestion-app (src/lib/infra/coolify.ts)
 * contra el mismo Coolify: /applications/private-github-app, /envs,
 * docker_compose_domains y /deploy.
 */

const API_URL = required("COOLIFY_API_URL").replace(/\/(api(\/v1)?)?\/?$/, "");
const TOKEN = required("COOLIFY_TOKEN");

/** Variables de la aplicación que se sincronizan al recurso de Coolify. */
const APP_ENV_KEYS = [
  // agente
  "DATABASE_URL",
  "DATABASE_CA_CERT",
  "AGENT_WEBHOOK_TOKEN",
  "AGENT_ADMIN_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_MEDIA_MODEL",
  "STT_API_URL",
  "STT_API_KEY",
  "STT_MODEL",
  "TASK_PROVIDER",
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_PROJECT_KEY",
  "JIRA_ISSUE_TYPE",
  "N8N_EVENTS_WEBHOOK_URL",
  // evolution
  "EVOLUTION_API_KEY",
  "EVOLUTION_INSTANCE",
  "EVOLUTION_DATABASE_URL",
  "EVOLUTION_DOMAIN",
  "EVOLUTION_IMAGE",
  "CONFIG_SESSION_PHONE_CLIENT",
  "EVOLUTION_LOG_LEVEL",
  // dominios / perfiles opcionales
  "AGENT_DOMAIN",
  "COMPOSE_PROFILES",
  // n8n (perfil opcional)
  "N8N_IMAGE",
  "N8N_DOMAIN",
  "N8N_ENCRYPTION_KEY",
  "N8N_DB_NAME",
  "N8N_DB_HOST",
  "N8N_DB_PORT",
  "N8N_DB_USER",
  "N8N_DB_PASSWORD",
  "N8N_DB_SSL",
];

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[deploy] Falta la variable ${name}`);
    process.exit(1);
  }
  return value;
}

async function coolify(path, init) {
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Coolify ${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** Idempotente: los proyectos de Coolify solo traen "production" de serie. */
async function ensureEnvironment(projectUuid, name) {
  try {
    await coolify(`/projects/${projectUuid}/environments`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("409") || msg.toLowerCase().includes("already exists")) return;
    throw err;
  }
}

async function setEnv(appUuid, key, value) {
  try {
    await coolify(`/applications/${appUuid}/envs`, {
      method: "POST",
      body: JSON.stringify({ key, value, is_preview: false }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("409") || msg.toLowerCase().includes("already")) {
      await coolify(`/applications/${appUuid}/envs`, {
        method: "PATCH",
        body: JSON.stringify({ key, value, is_preview: false }),
      });
      return;
    }
    throw err;
  }
}

async function syncEnvs(appUuid) {
  let count = 0;
  for (const key of APP_ENV_KEYS) {
    const value = process.env[key];
    if (value === undefined || value === "") continue; // sin valor → default del compose
    await setEnv(appUuid, key, value);
    count++;
  }
  console.log(`[deploy] ${count} variables sincronizadas`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Dominios por servicio del compose (equivale al campo Domains de la UI).
 *
 * Coolify NO acepta docker_compose_domains hasta que ha clonado y parseado el
 * compose del repo (docker_compose_raw), lo que ocurre durante el primer deploy.
 * Por eso: se llama DESPUÉS de lanzar un deploy y se reintenta el 422
 * "without docker_compose_raw" hasta que el compose esté parseado. Es
 * best-effort: si no lo consigue, avisa y sigue (los dominios se fijan en el
 * siguiente deploy) — nunca aborta el bootstrap.
 *
 * Esquema (http/https) configurable con DOMAIN_SCHEME (default https). Detrás de
 * un Cloudflare Tunnel el TLS lo pone Cloudflare en el edge y el tunnel entra al
 * :80 de Traefik en plano → usa DOMAIN_SCHEME=http para que Traefik NO fuerce
 * HTTPS ni pida Let's Encrypt (evita el bucle de redirección).
 */
async function syncDomains(appUuid) {
  const scheme = (process.env.DOMAIN_SCHEME || "https").toLowerCase() === "http" ? "http" : "https";
  const domains = [];
  if (process.env.AGENT_DOMAIN) {
    domains.push({ name: "agente", domain: `${scheme}://${process.env.AGENT_DOMAIN}` });
  }
  if (process.env.EVOLUTION_DOMAIN) {
    domains.push({ name: "evolution", domain: `${scheme}://${process.env.EVOLUTION_DOMAIN}` });
  }
  if (process.env.N8N_DOMAIN && (process.env.COMPOSE_PROFILES ?? "").includes("n8n")) {
    domains.push({ name: "n8n", domain: `${scheme}://${process.env.N8N_DOMAIN}` });
  }
  if (domains.length === 0) return true;

  const maxAttempts = 15;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await coolify(`/applications/${appUuid}`, {
        method: "PATCH",
        body: JSON.stringify({ docker_compose_domains: domains }),
      });
      console.log(`[deploy] Dominios: ${domains.map((d) => `${d.name}→${d.domain}`).join(", ")}`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // El compose aún no está parseado: reintentar.
      if (msg.includes("docker_compose_raw") || msg.includes("422")) {
        console.log(`[deploy] Compose aún no parseado (intento ${attempt}/${maxAttempts}); reintento en 8s…`);
        await sleep(8000);
        continue;
      }
      // Otro error: no bloquear el bootstrap por los dominios.
      console.log(`[deploy] Aviso: no se pudieron fijar los dominios: ${msg}`);
      return false;
    }
  }
  console.log(
    "[deploy] Aviso: Coolify no parseó el compose a tiempo; los dominios se fijarán en el próximo deploy (vuelve a lanzar el workflow con action=deploy).",
  );
  return false;
}

async function bootstrap() {
  const projectUuid = required("COOLIFY_PROJECT_UUID");
  const serverUuid = required("COOLIFY_SERVER_UUID");
  const githubAppUuid = required("COOLIFY_GITHUB_APP_UUID");
  const environmentName = process.env.COOLIFY_ENVIRONMENT_NAME || "production";
  const repository = process.env.GITHUB_REPOSITORY || "infra-tdp/tdp-agente-tareas";
  const branch = process.env.DEPLOY_BRANCH || process.env.GITHUB_REF_NAME || "main";

  await ensureEnvironment(projectUuid, environmentName);

  const created = await coolify("/applications/private-github-app", {
    method: "POST",
    body: JSON.stringify({
      project_uuid: projectUuid,
      server_uuid: serverUuid,
      environment_name: environmentName,
      github_app_uuid: githubAppUuid,
      git_repository: repository,
      git_branch: branch,
      build_pack: "dockercompose",
      docker_compose_location: "/docker-compose.yaml",
      name: "tdp-agente-tareas",
      description: "Agente de tareas WhatsApp (agente + Evolution API + Redis)",
      instant_deploy: false,
      // Auto-deploy en cada push vía la GitHub App de Coolify: el workflow solo
      // hace falta para bootstrap y para re-sincronizar envs/dominios.
      is_auto_deploy_enabled: true,
    }),
  });

  const uuid = created?.uuid;
  if (!uuid) throw new Error(`Coolify no devolvió uuid: ${JSON.stringify(created)}`);
  console.log(`[deploy] Recurso creado: ${uuid}`);
  console.log(`[deploy] Guarda COOLIFY_APP_UUID=${uuid} como variable del repo en GitHub.`);

  // Guardamos el uuid CUANTO ANTES (antes de deploy/dominios): así, aunque algo
  // posterior falle, el workflow puede persistir COOLIFY_APP_UUID y no se crea
  // un recurso duplicado al reintentar.
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_OUTPUT, `app_uuid=${uuid}\n`);
  }

  process.env.COOLIFY_APP_UUID = uuid;
  await syncEnvs(uuid);

  // 1º deploy: clona el repo y parsea el compose (habilita docker_compose_domains).
  await coolify(`/deploy?uuid=${uuid}&force=true`, { method: "POST" });
  console.log("[deploy] Deploy inicial lanzado (Coolify está parseando el compose)…");
  await sleep(10000);

  // Dominios (reintenta hasta que el compose esté parseado) y, si se fijan,
  // redeploy para que Traefik los enrute.
  const domainsSet = await syncDomains(uuid);
  if (domainsSet) {
    await coolify(`/deploy?uuid=${uuid}&force=true`, { method: "POST" });
    console.log("[deploy] Redeploy con dominios lanzado");
  }
}

async function deploy() {
  const uuid = required("COOLIFY_APP_UUID");
  await syncEnvs(uuid);
  // El compose ya está parseado de deploys anteriores → los dominios entran a la
  // primera; aun así es best-effort (no aborta si Coolify lo rechaza).
  await syncDomains(uuid);
  await coolify(`/deploy?uuid=${uuid}&force=true`, { method: "POST" });
  console.log("[deploy] Deploy lanzado");
}

const command = process.argv[2];
if (command === "bootstrap") await bootstrap();
else if (command === "deploy") await deploy();
else {
  console.error("Uso: node scripts/coolify/deploy.mjs <bootstrap|deploy>");
  process.exit(1);
}
