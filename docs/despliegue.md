# Despliegue — Coolify efímero, todo desde el repo

Principio: **Coolify no guarda ninguna configuración a mano**. Todo el stack
está definido en este repo (`docker-compose.yaml`: agente + Evolution API +
Redis, y n8n opcional), las variables viven en **GitHub → Settings → Secrets
and variables → Actions**, y el workflow
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) crea el
recurso en Coolify por API, sincroniza envs, asigna dominios y despliega.
Si el Coolify se pierde, se reconstruye entero con un click.

Los datos persistentes nunca están en el host de Coolify: el agente y
Evolution guardan TODO en la PostgreSQL gestionada de UpCloud (incluida la
sesión de WhatsApp → no hay que re-escanear el QR al recrear el contenedor).
Redis es solo caché.

## Preparación (una vez)

1. **BDs en la PostgreSQL gestionada**: usuarios/BDs `tdp_agente` (agente) y
   `evolution` (Evolution API). Si se activa n8n, también `n8n`.
2. **Secrets/Variables del repo en GitHub**: todos los nombres están en
   [.env.example](../.env.example) — sensibles como *Secrets*, el resto como
   *Variables* (dominios, modelos, proyecto de Jira…). Incluye el bloque
   `COOLIFY_*` (token de API, proyecto, servidor y GitHub App de Coolify).
   `COOLIFY_API_URL` debe ser la URL pública del panel (los runners de GitHub
   tienen que alcanzarla — es la misma que usa la GitHub App para webhooks).
3. La **GitHub App de Coolify** (Sources) debe tener acceso a este repo.

## Bootstrap (Coolify nuevo o recurso aún no creado)

Actions → **Deploy en Coolify** → *Run workflow* → `action = bootstrap`.

Crea el recurso Docker Compose apuntando a este repo (auto-deploy on push
activado), sincroniza envs y dominios, lanza el primer deploy y guarda
`COOLIFY_APP_UUID` como variable del repo.

## Día a día

- **Push a la rama de despliegue** → la GitHub App de Coolify reconstruye la
  imagen y despliega; además el workflow re-sincroniza envs/dominios (por si
  cambió algún Secret) y fuerza el deploy. Idempotente.
- **Cambió un Secret** sin tocar código → Actions → *Run workflow* →
  `action = deploy`.

## Único paso manual restante: la instancia de WhatsApp

Escanear un QR es inherentemente manual, pero es **estado en BD**, no
configuración de Coolify (sobrevive a recreaciones):

1. Entrar al manager de Evolution: `https://<EVOLUTION_DOMAIN>/manager`
   (API key = `EVOLUTION_API_KEY`).
2. Crear la instancia (`EVOLUTION_INSTANCE`, por defecto `tdp-tareas`) y
   escanear el QR con el número dedicado al agente (metido en los grupos que
   va a observar).
3. Configurar el webhook de la instancia:

```
URL:      https://<AGENT_DOMAIN>/webhook/evolution
Eventos:  MESSAGES_UPSERT
Headers:  x-agent-token: <AGENT_WEBHOOK_TOKEN>
```

(Alternativa sin headers: `.../webhook/evolution?token=<AGENT_WEBHOOK_TOKEN>`.)

## Conexión con TDP Gestión

En los Secrets de `tdp-gestion-app` (mismo mecanismo de despliegue):

```
TASK_AGENT_URL=https://<AGENT_DOMAIN>     # o http://agente:3100 si comparten red
TASK_AGENT_TOKEN=<AGENT_ADMIN_TOKEN>
```

Después, desde el módulo **/agente** del panel: sincronizar chats → monitorizar
los grupos → mapear personas a Jira → validar en modo shadow → activar.

## N8N (opcional, fase 4)

Variable `COMPOSE_PROFILES=n8n` + bloque `N8N_*` de `.env.example` (dominio,
encryption key fija y BD propia). El agente ya sabe notificar sus acciones a un
flujo con `N8N_EVENTS_WEBHOOK_URL`.

## Gestor de tareas (`TASK_PROVIDER`)

Elige `jira` o `linear` y define solo las variables de ese proveedor.

### Linear (recomendado, más simple)

1. **Personal API key**: Linear → Settings → Security & access → Personal API
   keys → *Create key* (empieza por `lin_api_`). Va en el Secret `LINEAR_API_KEY`.
2. **Team key**: la clave del equipo donde caen los issues (p. ej. `TDP`), visible
   en Settings → Teams. Va en la Variable `LINEAR_TEAM_KEY`.
3. `TASK_PROVIDER=linear`.

El agente usa la API GraphQL: búsqueda, creación, edición, comentarios,
prioridad (0-4) y cambio de estado (workflow states del equipo). Todo en
Markdown, sin claves de proyecto raras ni ADF.

### Jira Cloud

Un proyecto (su **KEY**, p. ej. `SCRUM`, se ve en la URL del tablero) y un
usuario/bot con API token (id.atlassian.com → Security → API tokens). Variables:
`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`. Con el flujo
estándar To Do / In Progress / Done no hay nada más que configurar.
