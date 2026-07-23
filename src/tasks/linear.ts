import { loadConfig } from "../config.js";
import { logger } from "../log.js";
import type {
  AssignableUser,
  CreateTaskInput,
  TaskDetail,
  TaskProvider,
  TaskSummary,
  UpdateTaskInput,
} from "./provider.js";

const log = logger("linear");

/**
 * Linear (GraphQL, https://api.linear.app/graphql). Autenticación con Personal
 * API key (header Authorization con la clave en crudo, sin "Bearer").
 *
 * La "key" de la interfaz = el identifier de Linear (p. ej. "TDP-123"). Los
 * issues viven en un equipo (LINEAR_TEAM_KEY). Prioridad = entero 0-4
 * (0 ninguna · 1 urgente · 2 alta · 3 media · 4 baja). Estado = workflow state
 * del equipo (se resuelve por nombre/tipo). Todo en Markdown, sin ADF.
 */

function lc() {
  const c = loadConfig();
  if (!c.LINEAR_API_KEY || !c.LINEAR_TEAM_KEY) {
    throw new Error("Configuración de Linear incompleta (LINEAR_API_KEY / LINEAR_TEAM_KEY).");
  }
  return { apiUrl: c.LINEAR_API_URL, apiKey: c.LINEAR_API_KEY, teamKey: c.LINEAR_TEAM_KEY };
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const { apiUrl, apiKey } = lc();
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: unknown };
  if (!res.ok || json.errors) {
    throw new Error(`Linear HTTP ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 400)}`);
  }
  return json.data as T;
}

/* --------------------------- Tipos GraphQL parciales ---------------------- */

type LinearUser = { id: string; displayName?: string; name?: string; email?: string; active?: boolean };
type LinearState = { id: string; name: string; type: string };
type LinearIssueNode = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number;
  priorityLabel?: string;
  url: string;
  updatedAt?: string;
  state?: LinearState;
  assignee?: { displayName?: string; name?: string } | null;
  labels?: { nodes: { name: string }[] };
  comments?: { nodes: { body: string; createdAt: string; user?: { displayName?: string; name?: string } }[] };
};

/* ------------------------------- Prioridad -------------------------------- */

function priorityToInt(name?: string): number | undefined {
  if (!name) return undefined;
  const n = name.trim().toLowerCase();
  if (["urgent", "urgente", "highest", "crítica", "critica"].includes(n)) return 1;
  if (["high", "alta"].includes(n)) return 2;
  if (["medium", "normal", "media"].includes(n)) return 3;
  if (["low", "lowest", "baja"].includes(n)) return 4;
  if (["none", "ninguna", "sin"].includes(n)) return 0;
  return undefined;
}

/* -------------------------------- Equipo ---------------------------------- */

let teamIdCache: string | null = null;

async function teamId(): Promise<string> {
  if (teamIdCache) return teamIdCache;
  const key = lc().teamKey;
  const data = await gql<{ teams: { nodes: { id: string; key: string }[] } }>(
    `query($key:String!){ teams(filter:{ key:{ eq:$key } }, first:1){ nodes{ id key } } }`,
    { key },
  );
  const team = data.teams.nodes[0];
  if (!team) throw new Error(`No existe el equipo de Linear con key "${key}".`);
  teamIdCache = team.id;
  return team.id;
}

async function teamStates(): Promise<LinearState[]> {
  const id = await teamId();
  const data = await gql<{ team: { states: { nodes: LinearState[] } } }>(
    `query($id:String!){ team(id:$id){ states{ nodes{ id name type } } } }`,
    { id },
  );
  return data.team.states.nodes;
}

/** Resuelve nombres de etiqueta a labelIds existentes del equipo (ignora las que no existan). */
async function resolveLabelIds(names: string[]): Promise<string[]> {
  if (!names.length) return [];
  const id = await teamId();
  const data = await gql<{ team: { labels: { nodes: { id: string; name: string }[] } } }>(
    `query($id:String!){ team(id:$id){ labels{ nodes{ id name } } } }`,
    { id },
  );
  const byName = new Map(data.team.labels.nodes.map((l) => [l.name.toLowerCase(), l.id]));
  return names.map((n) => byName.get(n.toLowerCase())).filter((v): v is string => Boolean(v));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resuelve el asignado a un UUID de usuario de Linear. Acepta un UUID (lo
 * devuelve tal cual), un email o un nombre (busca el usuario). Devuelve null si
 * no se puede resolver — el caller decide degradar (crear sin asignar) en vez de
 * romper. Esto tolera que el mapeo de personas tenga el email en vez del id.
 */
async function resolveAssigneeId(value?: string): Promise<string | null> {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (UUID_RE.test(v)) return v;
  const filter = v.includes("@")
    ? `email:{ eq:$v }`
    : `name:{ containsIgnoreCase:$v }`;
  try {
    const data = await gql<{ users: { nodes: LinearUser[] } }>(
      `query($v:String!){ users(filter:{ ${filter} }, first:1){ nodes{ id active } } }`,
      { v },
    );
    return data.users.nodes[0]?.id ?? null;
  } catch (err) {
    log.warn(`No se pudo resolver el asignado "${v}"`, err);
    return null;
  }
}

const ISSUE_FIELDS = `
  id identifier title description priority priorityLabel url updatedAt
  state { id name type }
  assignee { displayName name }
  labels { nodes { name } }
  comments { nodes { body createdAt user { displayName name } } }
`;

function assigneeName(a?: { displayName?: string; name?: string } | null): string | null {
  return a?.displayName ?? a?.name ?? null;
}

function toSummary(n: LinearIssueNode): TaskSummary {
  return {
    key: n.identifier,
    summary: n.title,
    status: n.state?.name ?? "",
    priority: n.priority ? (n.priorityLabel ?? null) : null,
    assignee: assigneeName(n.assignee),
    updatedAt: n.updatedAt ?? null,
    url: n.url,
  };
}

/** Busca el issue por su identifier (KEY-NUM) dentro del equipo configurado. */
async function fetchIssueByKey(key: string): Promise<LinearIssueNode> {
  const num = Number(key.split("-").pop());
  if (!Number.isFinite(num)) throw new Error(`Identificador de issue inválido: "${key}".`);
  const id = await teamId();
  const data = await gql<{ issues: { nodes: LinearIssueNode[] } }>(
    `query($id:ID!, $num:Float!){
       issues(filter:{ team:{ id:{ eq:$id } }, number:{ eq:$num } }, first:1){ nodes { ${ISSUE_FIELDS} } }
     }`,
    { id, num },
  );
  const issue = data.issues.nodes[0];
  if (!issue) throw new Error(`No se encontró el issue ${key} en el equipo.`);
  return issue;
}

export const linearProvider: TaskProvider = {
  name: "linear",
  get projectLabel() {
    return loadConfig().LINEAR_TEAM_KEY ?? "";
  },

  async searchTasks(text, opts) {
    const id = await teamId();
    const term = text.trim();

    // Búsqueda por texto con el query `issues` (el endpoint `issueSearch` está
    // deprecado). Se tokeniza el término y se pide que el título O la descripción
    // contengan alguna palabra significativa → buena cobertura para "no dupliques".
    const filter: Record<string, unknown> = { team: { id: { eq: id } } };
    if (term) {
      const words = term
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 4)
        .slice(0, 8);
      const needles = words.length ? words : [term];
      filter.or = needles.flatMap((w) => [
        { title: { containsIgnoreCase: w } },
        { description: { containsIgnoreCase: w } },
      ]);
    }

    const data = await gql<{ issues: { nodes: LinearIssueNode[] } }>(
      `query($filter: IssueFilter!){
         issues(filter:$filter, first:25, orderBy:updatedAt){ nodes { ${ISSUE_FIELDS} } }
       }`,
      { filter },
    );
    const nodes = opts?.includeDone
      ? data.issues.nodes
      : data.issues.nodes.filter((n) => !["completed", "canceled"].includes(n.state?.type ?? ""));
    return nodes.map(toSummary);
  },

  async getTask(key) {
    const n = await fetchIssueByKey(key);
    const comments = (n.comments?.nodes ?? []).slice(-10).map((c) => ({
      author: assigneeName(c.user) ?? "",
      body: c.body,
      createdAt: c.createdAt,
    }));
    return {
      ...toSummary(n),
      description: n.description ?? "",
      labels: (n.labels?.nodes ?? []).map((l) => l.name),
      comments,
    } satisfies TaskDetail;
  },

  async createTask(input) {
    const id = await teamId();
    const issueInput: Record<string, unknown> = {
      teamId: id,
      title: input.summary,
      description: input.description,
    };
    const prio = priorityToInt(input.priority);
    if (prio !== undefined) issueInput.priority = prio;
    if (input.assigneeAccountId) {
      const assigneeId = await resolveAssigneeId(input.assigneeAccountId);
      if (assigneeId) issueInput.assigneeId = assigneeId;
      else log.warn(`Asignado "${input.assigneeAccountId}" no resuelto; se crea sin asignar.`);
    }
    if (input.labels?.length) {
      const labelIds = await resolveLabelIds(input.labels);
      if (labelIds.length) issueInput.labelIds = labelIds;
    }
    const data = await gql<{ issueCreate: { success: boolean; issue: LinearIssueNode } }>(
      `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ ${ISSUE_FIELDS} } } }`,
      { input: issueInput },
    );
    if (!data.issueCreate.success) throw new Error("Linear rechazó la creación del issue.");
    log.info(`Issue creado: ${data.issueCreate.issue.identifier}`);
    return toSummary(data.issueCreate.issue);
  },

  async updateTask(key, patch: UpdateTaskInput) {
    const issue = await fetchIssueByKey(key);
    const update: Record<string, unknown> = {};
    if (patch.summary !== undefined) update.title = patch.summary;
    if (patch.description !== undefined) update.description = patch.description;
    if (patch.priority !== undefined) {
      const prio = priorityToInt(patch.priority);
      if (prio !== undefined) update.priority = prio;
    }
    if (patch.assigneeAccountId !== undefined) {
      if (!patch.assigneeAccountId) {
        update.assigneeId = null; // desasignar explícitamente
      } else {
        const assigneeId = await resolveAssigneeId(patch.assigneeAccountId);
        // Si no se resuelve, no tocamos el asignado (mejor que fallar la update).
        if (assigneeId) update.assigneeId = assigneeId;
        else log.warn(`Asignado "${patch.assigneeAccountId}" no resuelto; se deja el asignado actual.`);
      }
    }
    if (patch.labels !== undefined) update.labelIds = await resolveLabelIds(patch.labels);
    if (Object.keys(update).length === 0) return;
    await gql(`mutation($id:String!, $input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success } }`, {
      id: issue.id,
      input: update,
    });
  },

  async addComment(key, body) {
    const issue = await fetchIssueByKey(key);
    await gql(`mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success } }`, {
      input: { issueId: issue.id, body },
    });
  },

  async transitionTask(key, targetStatus) {
    const issue = await fetchIssueByKey(key);
    const states = await teamStates();
    const want = targetStatus.trim().toLowerCase();
    // Sinónimos comunes → tipo de estado de Linear.
    const typeHint = ["done", "cerrar", "cerrado", "completado", "finalizado"].some((w) => want.includes(w))
      ? "completed"
      : ["cancel", "cancelado", "descartado"].some((w) => want.includes(w))
        ? "canceled"
        : ["curso", "progress", "haciendo", "started"].some((w) => want.includes(w))
          ? "started"
          : ["todo", "backlog", "pendiente", "abrir", "reabrir"].some((w) => want.includes(w))
            ? "unstarted"
            : null;

    const match =
      states.find((s) => s.name.toLowerCase() === want) ??
      states.find((s) => s.name.toLowerCase().includes(want)) ??
      (typeHint ? states.find((s) => s.type === typeHint) : undefined);

    if (!match) {
      const available = states.map((s) => s.name).join(", ");
      throw new Error(`Sin estado hacia "${targetStatus}". Disponibles: ${available || "ninguno"}`);
    }
    await gql(`mutation($id:String!, $input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success } }`, {
      id: issue.id,
      input: { stateId: match.id },
    });
    return match.name;
  },

  async listAssignableUsers(query) {
    const q = query.trim();
    const filter = q ? `, filter:{ name:{ containsIgnoreCase:$q } }` : "";
    const data = await gql<{ users: { nodes: LinearUser[] } }>(
      `query($q:String){ users(first:20${filter}){ nodes{ id displayName name email active } } }`,
      q ? { q } : {},
    );
    return (data.users.nodes ?? [])
      .filter((u) => u.active !== false)
      .map(
        (u): AssignableUser => ({
          accountId: u.id,
          displayName: u.displayName ?? u.name ?? "",
          email: u.email ?? null,
        }),
      );
  },

  async healthcheck() {
    try {
      const key = lc().teamKey;
      await teamId();
      return { ok: true, detail: `Equipo ${key} accesible` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
};
