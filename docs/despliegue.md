# Despliegue en Coolify

Tres recursos en Coolify (mismo proyecto, red `coolify`):

## 1. Evolution API (recurso propio)

- **+ New Resource → Docker Image** con la imagen oficial
  `evoapicloud/evolution-api:latest` (o la versión fijada que se decida).
- Variables mínimas: `AUTHENTICATION_API_KEY` (será `EVOLUTION_API_KEY` del
  agente), BD propia si se quiere persistencia completa (soporta Postgres) y
  `CONFIG_SESSION_PHONE_CLIENT=TDP`.
- Dominio interno o público (p. ej. `evolution.tallerdelpatinete.es`).
- En el manager (`/manager`): crear la instancia (p. ej. `tdp-tareas`) y
  **escanear el QR** con el número de teléfono dedicado al agente.

> El número del agente debe estar metido en los grupos que va a observar.

## 2. Este agente (build desde el repo)

- **+ New Resource → Docker Compose** desde `infra-tdp/tdp-agente-tareas`
  (GitHub App, auto-deploy on push, igual que tdp-gestion-app).
- Variables: ver [.env.example](../.env.example). La BD es un usuario/BD nuevos
  (`tdp_agente`) en la PostgreSQL gestionada de UpCloud; las migraciones se
  aplican solas al arrancar.
- Dominio (campo *Domains for app*), p. ej. `agente.tallerdelpatinete.es`
  → puerto 3100.

### Webhook de la instancia

En Evolution (manager o API), configurar el webhook de la instancia:

```
URL:      https://agente.tallerdelpatinete.es/webhook/evolution
Eventos:  MESSAGES_UPSERT
Headers:  x-agent-token: <AGENT_WEBHOOK_TOKEN>
```

Alternativa sin headers: `.../webhook/evolution?token=<AGENT_WEBHOOK_TOKEN>`.

## 3. TDP Gestión (módulo Agente WhatsApp)

En el recurso de `tdp-gestion-app` añadir:

```
TASK_AGENT_URL=http://<servicio-del-agente>:3100    # o el dominio público
TASK_AGENT_TOKEN=<AGENT_ADMIN_TOKEN>
```

Si ambos recursos comparten la red `coolify`, `TASK_AGENT_URL` puede apuntar al
nombre interno del servicio (sin salir a internet).

## Arranque funcional (desde TDP Gestión → Agente WhatsApp)

1. **Sincronizar chats** — trae los grupos/chats de la instancia.
2. **Monitorizar** el/los grupos de trabajo (p. ej. el grupo donde Raúl asigna
   tareas) y, si procede, permitir respuestas por chat.
3. **Mapear personas** — a cada participante su `accountId` de Jira (el panel
   ofrece el buscador de usuarios asignables del proyecto).
4. Dejarlo unos días en **modo shadow** revisando la auditoría (qué habría
   hecho) y, cuando el criterio convenza, pasar a **modo activo**.

## Jira

- Un proyecto (p. ej. `TDP`) y un usuario/bot con API token
  (id.atlassian.com → Security → API tokens).
- El agente usa: búsqueda JQL, creación, edición, comentarios y transiciones.
  Con el flujo estándar de Jira (To Do / In Progress / Done) no hay que
  configurar nada más.
