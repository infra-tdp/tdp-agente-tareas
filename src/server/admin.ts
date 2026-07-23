import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { desc, eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { loadConfig } from "../config.js";
import { getSettings, updateSettings, SettingsSchema } from "../settings.js";
import { connectionState } from "../evolution/client.js";
import { getTaskProvider } from "../tasks/index.js";
import { refreshLinks } from "../tasks/live.js";
import { ingestStats, syncChatsFromEvolution } from "../ingest.js";
import { forceRun } from "../agent/batcher.js";

/**
 * API interna que consume TDP Gestión (toda la UI de administración vive allí).
 * Autenticación: Authorization: Bearer AGENT_ADMIN_TOKEN.
 */

function bearerOk(request: FastifyRequest): boolean {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = loadConfig().AGENT_ADMIN_TOKEN;
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerAdminRoutes(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith("/admin")) return;
    if (!bearerOk(request)) return reply.code(401).send({ error: "no autorizado" });
  });

  /* ------------------------------ Estado ---------------------------------- */

  app.get("/admin/overview", async () => {
    const cfg = loadConfig();
    const [instanceState, providerHealth, stats, settings, lastRuns] = await Promise.all([
      connectionState(),
      getTaskProvider().healthcheck(),
      ingestStats(),
      getSettings(),
      db
        .select({
          id: schema.agentRuns.id,
          chatId: schema.agentRuns.chatId,
          status: schema.agentRuns.status,
          shadow: schema.agentRuns.shadow,
          messageCount: schema.agentRuns.messageCount,
          summary: schema.agentRuns.summary,
          error: schema.agentRuns.error,
          createdAt: schema.agentRuns.createdAt,
          finishedAt: schema.agentRuns.finishedAt,
          chatName: schema.chats.name,
          chatJid: schema.chats.jid,
        })
        .from(schema.agentRuns)
        .innerJoin(schema.chats, eq(schema.agentRuns.chatId, schema.chats.id))
        .orderBy(desc(schema.agentRuns.id))
        .limit(10),
    ]);

    return {
      instance: { name: cfg.EVOLUTION_INSTANCE, state: instanceState },
      provider: { name: cfg.TASK_PROVIDER, projectKey: getTaskProvider().projectLabel, ...providerHealth },
      stt: { configured: Boolean(cfg.STT_API_KEY), model: cfg.STT_MODEL },
      model: cfg.ANTHROPIC_MODEL,
      stats,
      settings,
      lastRuns,
    };
  });

  /* ------------------------------- Chats ----------------------------------- */

  app.get("/admin/chats", async () => {
    return db
      .select()
      .from(schema.chats)
      .orderBy(desc(schema.chats.monitored), desc(schema.chats.lastMessageAt));
  });

  app.post("/admin/chats/sync", async () => syncChatsFromEvolution());

  const chatPatch = z.object({
    monitored: z.boolean().optional(),
    allowReplies: z.boolean().optional(),
    notes: z.string().max(4000).nullable().optional(),
  });

  app.patch("/admin/chats/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "id inválido" });
    const parsed = chatPatch.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const [updated] = await db
      .update(schema.chats)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(schema.chats.id, id))
      .returning();
    if (!updated) return reply.code(404).send({ error: "chat no encontrado" });
    return updated;
  });

  /** Fuerza el procesado inmediato del lote pendiente de un chat. */
  app.post("/admin/chats/:id/process", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "id inválido" });
    forceRun(id);
    return { ok: true };
  });

  /* ------------------------------ Personas --------------------------------- */

  app.get("/admin/people", async () => {
    return db.select().from(schema.people).orderBy(desc(schema.people.updatedAt));
  });

  const personPatch = z.object({
    displayName: z.string().max(200).nullable().optional(),
    taskAccountId: z.string().max(128).nullable().optional(),
    aliases: z.string().max(1000).nullable().optional(),
  });

  app.patch("/admin/people/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "id inválido" });
    const parsed = personPatch.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const [updated] = await db
      .update(schema.people)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(schema.people.id, id))
      .returning();
    if (!updated) return reply.code(404).send({ error: "persona no encontrada" });
    return updated;
  });

  /** Usuarios asignables del gestor (para el selector de mapeo del panel). */
  app.get("/admin/provider/users", async (request) => {
    const query = (request.query as { q?: string }).q ?? "";
    return getTaskProvider().listAssignableUsers(query);
  });

  /* --------------------------- Runs y auditoría ---------------------------- */

  app.get("/admin/runs", async (request) => {
    const q = request.query as { chatId?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit ?? 30) || 30, 100);
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const chatId = Number(q.chatId);
    const whereChat =
      Number.isInteger(chatId) && q.chatId ? eq(schema.agentRuns.chatId, chatId) : undefined;
    return db
      .select({
        id: schema.agentRuns.id,
        chatId: schema.agentRuns.chatId,
        status: schema.agentRuns.status,
        shadow: schema.agentRuns.shadow,
        messageCount: schema.agentRuns.messageCount,
        summary: schema.agentRuns.summary,
        error: schema.agentRuns.error,
        inputTokens: schema.agentRuns.inputTokens,
        outputTokens: schema.agentRuns.outputTokens,
        createdAt: schema.agentRuns.createdAt,
        finishedAt: schema.agentRuns.finishedAt,
        chatName: schema.chats.name,
        chatJid: schema.chats.jid,
      })
      .from(schema.agentRuns)
      .innerJoin(schema.chats, eq(schema.agentRuns.chatId, schema.chats.id))
      .where(whereChat)
      .orderBy(desc(schema.agentRuns.id))
      .limit(limit)
      .offset(offset);
  });

  app.get("/admin/runs/:id/actions", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "id inválido" });
    return db
      .select()
      .from(schema.agentActions)
      .where(eq(schema.agentActions.runId, id))
      .orderBy(schema.agentActions.id);
  });

  app.get("/admin/actions", async (request) => {
    const q = request.query as { limit?: string };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    return db
      .select()
      .from(schema.agentActions)
      .orderBy(desc(schema.agentActions.id))
      .limit(limit);
  });

  app.get("/admin/tasks", async (request) => {
    const includeDone = ["1", "true"].includes(String((request.query as { includeDone?: string }).includeDone ?? ""));
    // Estado EN VIVO: refresca desde el gestor (Linear/Jira) antes de mostrar.
    const links = await db
      .select()
      .from(schema.taskLinks)
      .orderBy(desc(schema.taskLinks.updatedAt))
      .limit(300);
    const enriched = await refreshLinks(links);

    // Nombres de chat para la columna "Chat".
    const chatRows = await db.select({ id: schema.chats.id, name: schema.chats.name }).from(schema.chats);
    const chatName = new Map(chatRows.map((c) => [c.id, c.name]));

    return enriched
      .filter((l) => includeDone || !l.done) // por defecto: solo abiertos
      .slice(0, 200)
      .map((l) => ({
        id: l.id,
        chatId: l.chatId,
        provider: l.provider,
        taskKey: l.taskKey,
        summary: l.summary,
        status: l.status,
        priority: l.priority,
        assignee: l.assignee,
        lastAction: l.lastAction,
        updatedAt: l.updatedAt,
        chatName: chatName.get(l.chatId) ?? "",
        url: l.url,
        done: l.done,
      }));
  });

  /* ------------------------------- Ajustes ---------------------------------- */

  app.get("/admin/settings", async () => getSettings());

  app.put("/admin/settings", async (request, reply) => {
    const parsed = SettingsSchema.partial().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return updateSettings(parsed.data);
  });
}
