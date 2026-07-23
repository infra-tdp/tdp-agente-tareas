import Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { loadConfig } from "../config.js";
import { logger } from "../log.js";
import { getSettings } from "../settings.js";
import { processMessageMedia } from "../media/process.js";
import { buildSystemPrompt } from "./prompts.js";
import { buildUserContext } from "./context.js";
import { TOOL_DEFINITIONS, ToolExecutor } from "./tools.js";
import { getTaskProvider } from "../tasks/index.js";
import { refreshChatLinks } from "../tasks/live.js";

const log = logger("agent");

const MAX_TURNS = 16;

let anthropic: Anthropic | null = null;
function client(): Anthropic {
  if (!anthropic) anthropic = new Anthropic({ apiKey: loadConfig().ANTHROPIC_API_KEY });
  return anthropic;
}

/**
 * Procesa el lote de mensajes pendientes de un chat: completa el media que
 * falte, monta el contexto, y deja a Claude operar con las herramientas hasta
 * que dé su resumen final. Todo queda auditado en agent_runs/agent_actions.
 */
export async function runAgentForChat(chatId: number): Promise<void> {
  const cfg = loadConfig();
  const settings = await getSettings();

  const [chat] = await db.select().from(schema.chats).where(eq(schema.chats.id, chatId)).limit(1);
  if (!chat || !chat.monitored) return;

  const pending = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.chatId, chatId),
        eq(schema.messages.processed, false),
        eq(schema.messages.fromMe, false),
      ),
    )
    .orderBy(asc(schema.messages.sentAt), asc(schema.messages.id));
  if (pending.length === 0) return;

  // Completar transcripciones/descripciones que sigan pendientes
  for (const msg of pending) {
    if (msg.mediaStatus === "pending") await processMessageMedia(msg.id);
  }

  const shadow = settings.mode === "shadow";
  // "Se permite responder" según config (global + por chat). El bloqueo real en
  // shadow lo hace el executor (simula el envío en vez de mandarlo), igual que
  // con la creación de tickets — así en shadow no salta un error, se registra
  // "esto respondería".
  const canReply = settings.repliesEnabled && chat.allowReplies;

  const [run] = await db
    .insert(schema.agentRuns)
    .values({
      chatId,
      status: "running",
      shadow,
      messageCount: pending.length,
      startedAt: new Date(),
    })
    .returning();

  log.info(
    `Run #${run.id} chat "${chat.name || chat.jid}" — ${pending.length} mensajes (${shadow ? "shadow" : "active"})`,
  );

  try {
    // Estado EN VIVO: refresca en task_links el estado real de los tickets del
    // chat (por si se cerraron a mano) para que el contexto anti-duplicados sea
    // fiel. No bloquea la ejecución si el gestor falla.
    await refreshChatLinks(chatId).catch((err) =>
      log.warn(`No se pudieron refrescar los tickets del chat ${chatId}`, err),
    );

    const system = buildSystemPrompt({
      settings,
      providerName: cfg.TASK_PROVIDER,
      projectKey: getTaskProvider().projectLabel,
      chatName: chat.name || chat.jid,
      chatNotes: chat.notes,
      canReply: settings.repliesEnabled && chat.allowReplies,
    });
    const userContext = await buildUserContext({
      chatId,
      settings,
      batchIds: pending.map((m) => m.id),
    });

    const executor = new ToolExecutor({
      runId: run.id,
      chatId,
      chatJid: chat.jid,
      shadow,
      canReply,
      settings,
    });

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: userContext }];
    let inputTokens = 0;
    let outputTokens = 0;
    let summary = "";

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client().messages.create({
        model: cfg.ANTHROPIC_MODEL,
        max_tokens: 4000,
        system,
        tools: TOOL_DEFINITIONS,
        messages,
      });
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const texts = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (texts) summary = texts;

      if (toolUses.length === 0 || response.stop_reason !== "tool_use") break;

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const { result, isError } = await executor.execute(
          use.name,
          (use.input ?? {}) as Record<string, unknown>,
        );
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: result,
          is_error: isError,
        });
      }
      messages.push({ role: "user", content: results });
    }

    await db
      .update(schema.messages)
      .set({ processed: true })
      .where(inArray(schema.messages.id, pending.map((m) => m.id)));

    await db
      .update(schema.agentRuns)
      .set({
        status: "success",
        summary: summary || "(sin resumen)",
        inputTokens,
        outputTokens,
        finishedAt: new Date(),
      })
      .where(eq(schema.agentRuns.id, run.id));

    log.info(`Run #${run.id} OK — ${summary.slice(0, 160)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Run #${run.id} falló`, err);
    // Los mensajes NO se marcan procesados: se reintentarán en el siguiente lote.
    await db
      .update(schema.agentRuns)
      .set({ status: "error", error: message.slice(0, 4000), finishedAt: new Date() })
      .where(eq(schema.agentRuns.id, run.id));
  }
}
