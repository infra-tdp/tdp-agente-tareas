import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "../config.js";
import { logger } from "../log.js";
import { ingestMessageEvent } from "../ingest.js";

const log = logger("webhook");

function tokenOk(provided: string | undefined): boolean {
  const expected = loadConfig().AGENT_WEBHOOK_TOKEN;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Webhook de Evolution API. Configurar la instancia con:
 *   url: https://<agente>/webhook/evolution
 *   eventos: MESSAGES_UPSERT
 *   headers: { "x-agent-token": AGENT_WEBHOOK_TOKEN }  (o ?token= en la URL)
 * Se responde 200 rápido y se procesa en segundo plano: si el webhook tarda,
 * Evolution reintenta y duplica entregas (el dedupe por wa_message_id cubre eso).
 */
export function registerWebhookRoutes(app: FastifyInstance): void {
  app.post("/webhook/evolution", async (request, reply) => {
    const headerToken = request.headers["x-agent-token"];
    const queryToken = (request.query as Record<string, string | undefined>)?.token;
    if (!tokenOk(typeof headerToken === "string" ? headerToken : queryToken)) {
      return reply.code(401).send({ error: "token inválido" });
    }

    const body = (request.body ?? {}) as {
      event?: string;
      data?: unknown;
    };

    const event = (body.event ?? "").toLowerCase().replace(/_/g, ".");
    if (event === "messages.upsert") {
      // data puede ser un objeto o (según versión) un array de mensajes
      const items = Array.isArray(body.data) ? body.data : [body.data];
      for (const item of items) {
        ingestMessageEvent(item).catch((err) => log.error("Fallo ingiriendo mensaje", err));
      }
    }

    return reply.code(200).send({ ok: true });
  });
}
