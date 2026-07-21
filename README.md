# TDP Agente de tareas

Agente de IA de **Taller del Patinete** conectado a un número de WhatsApp
mediante **Evolution API**. Observa los grupos/chats que se le indiquen, lee los
mensajes (texto, **notas de voz** y **vídeos/imágenes**), entiende qué tareas se
están pidiendo y mantiene al día el gestor externo (**Jira**): crea tickets,
comenta novedades, cambia prioridades, reasigna y cierra — **sin duplicar
tickets**.

> Este repo contiene SOLO el servicio desplegable (infra). Toda la
> administración — qué chats se monitorizan, mapeo de personas a Jira, modo de
> trabajo, auditoría — vive en el módulo **Agente WhatsApp** de
> [`tdp-gestion-app`](https://github.com/infra-tdp/tdp-gestion-app), que
> consume la API interna `/admin` de este servicio.

## Cómo funciona

```
WhatsApp ──► Evolution API ──webhook──► tdp-agente-tareas
                                            │
                 1. Normaliza y guarda el mensaje (Postgres)
                 2. Media → texto: nota de voz → STT (Whisper),
                    imagen/vídeo → descripción con visión (Claude)
                 3. Debounce por chat (Raúl escribe en ráfagas):
                    espera N segundos de silencio y agrupa el lote
                 4. Agente Claude con herramientas sobre Jira:
                    search/get/create/update/comment/transition
                    (busca SIEMPRE antes de crear → sin duplicados)
                 5. Auditoría completa: agent_runs + agent_actions
                                            │
                       TDP Gestión ◄──API /admin── (config + auditoría)
```

Decisiones:

- **Servicio dedicado, no flujo de N8N**: el bucle agéntico (contexto por chat,
  anti-duplicados, batching, auditoría) es código; N8N queda como canal
  opcional de notificaciones (`N8N_EVENTS_WEBHOOK_URL`, fase 4 del roadmap).
- **Modo `shadow` por defecto**: el agente razona y registra qué haría, pero no
  escribe en Jira ni en WhatsApp hasta que se active desde el panel. Permite
  validar su criterio con tráfico real sin riesgo.
- **Privacidad**: solo se almacena contenido de los chats marcados como
  monitorizados; del resto únicamente se registra su existencia para poder
  activarlos desde el panel.
- **Jira detrás de una interfaz** (`src/tasks/provider.ts`): cambiar de gestor
  no toca el agente.

## Stack

Node 22 · TypeScript · Fastify · PostgreSQL 17 (Drizzle ORM) · Anthropic API
(agente + visión) · API compatible OpenAI para STT (Whisper) · ffmpeg ·
desplegado en **Coolify** (build desde código en cada push).

## Desarrollo local

```bash
npm install
cp .env.example .env            # rellena BD, Evolution, Anthropic y Jira
npx drizzle-kit generate        # si cambiaste src/db/schema.ts
node scripts/migrate.mjs        # aplica migraciones
npm run dev                     # http://localhost:3100/health
```

## API

| Ruta | Uso |
|---|---|
| `GET /health` | Healthcheck (Coolify/monitores) |
| `POST /webhook/evolution` | Webhook de Evolution (`MESSAGES_UPSERT`), auth por `x-agent-token` |
| `GET/POST/PATCH /admin/*` | API interna para TDP Gestión (Bearer `AGENT_ADMIN_TOKEN`): overview, chats, personas, runs, acciones, tareas vinculadas y ajustes |

## Puesta en producción

Ver [`docs/despliegue.md`](docs/despliegue.md): recursos de Coolify (Evolution
API + este agente), creación de la instancia de WhatsApp, configuración del
webhook y variables de entorno. La conexión con el panel se explica en
`docs/agente-tareas.md` de `tdp-gestion-app`.
