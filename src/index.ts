import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { logger } from "./log.js";
import { registerWebhookRoutes } from "./server/webhook.js";
import { registerAdminRoutes } from "./server/admin.js";
import { recoverPending } from "./agent/batcher.js";
import { hasFfmpeg } from "./media/ffmpeg.js";

const log = logger("main");

async function main(): Promise<void> {
  const cfg = loadConfig();

  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024 * 1024, // los webhooks de Evolution pueden traer miniaturas en base64
  });

  app.get("/health", async () => ({ ok: true, service: "tdp-agente-tareas" }));

  registerWebhookRoutes(app);
  registerAdminRoutes(app);

  await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
  log.info(`Escuchando en :${cfg.PORT} — instancia Evolution "${cfg.EVOLUTION_INSTANCE}"`);

  await hasFfmpeg(); // deja el aviso en el log si falta
  await recoverPending();
}

main().catch((err) => {
  log.error("Arranque fallido", err);
  process.exit(1);
});
