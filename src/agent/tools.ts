import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { loadConfig } from "../config.js";
import { logger } from "../log.js";
import { getMediaBase64, sendText } from "../evolution/client.js";
import { getTaskProvider } from "../tasks/index.js";
import type { MediaFile } from "../tasks/provider.js";
import type { AgentSettings } from "../settings.js";

const log = logger("tools");

/** Definición de herramientas que se pasa a Claude en cada ejecución. */
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "search_tasks",
    description:
      "Busca tickets en el gestor de tareas por texto libre (resumen y contenido). Úsala SIEMPRE antes de crear un ticket, con varios términos si hace falta. Por defecto solo devuelve tickets abiertos.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Términos de búsqueda (castellano, palabras clave del asunto)" },
        include_done: { type: "boolean", description: "true para incluir también tickets cerrados" },
      },
      required: ["text"],
    },
  },
  {
    name: "get_task",
    description: "Detalle completo de un ticket: descripción, estado, prioridad, asignado y últimos comentarios.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string", description: "Clave del ticket, p. ej. TDP-123" } },
      required: ["key"],
    },
  },
  {
    name: "create_task",
    description:
      "Crea un ticket nuevo. Solo tras buscar con search_tasks y confirmar que no existe uno equivalente.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Título corto y accionable, en castellano" },
        description: { type: "string", description: "Contexto completo: qué, quién, cuándo, detalles y cita del mensaje original" },
        priority: { type: "string", description: "Prioridad del gestor (Highest/High/Medium/Low/Lowest). Omitir si el chat no la indica" },
        assignee_account_id: { type: "string", description: "accountId del asignado según el mapeo de personas del contexto" },
        labels: { type: "array", items: { type: "string" }, description: "Etiquetas opcionales" },
      },
      required: ["summary", "description"],
    },
  },
  {
    name: "update_task",
    description: "Actualiza campos de un ticket existente: título, descripción, prioridad, asignado o etiquetas.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string" },
        summary: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", description: "Highest/High/Medium/Low/Lowest" },
        assignee_account_id: { type: "string", description: "accountId nuevo; cadena vacía para desasignar" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["key"],
    },
  },
  {
    name: "comment_task",
    description:
      "Añade un comentario a un ticket: novedades, observaciones, avances parciales o contexto nuevo del chat.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string" },
        body: { type: "string", description: "Comentario en castellano, con cita del mensaje original si aporta" },
      },
      required: ["key", "body"],
    },
  },
  {
    name: "transition_task",
    description:
      "Cambia el estado de un ticket (cerrarlo, reabrirlo, pasarlo a en curso…). Cierra solo con confirmación clara en el chat.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string" },
        target_status: { type: "string", description: "Estado destino aproximado: 'Done', 'En curso', 'To Do'…" },
      },
      required: ["key", "target_status"],
    },
  },
  {
    name: "attach_media",
    description:
      "Sube al ticket los archivos (imágenes, vídeos, documentos) de los mensajes indicados, además de su descripción en texto. Los mensajes con adjunto aparecen en el contexto marcados como [adjunto id=N]. Úsalo cuando la imagen o el vídeo sean evidencia relevante para el ticket.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Clave del ticket, p. ej. TAL-6" },
        media_ids: {
          type: "array",
          items: { type: "number" },
          description: "IDs de los mensajes con adjunto (los [adjunto id=N] del contexto)",
        },
      },
      required: ["key", "media_ids"],
    },
  },
  {
    name: "send_whatsapp_reply",
    description:
      "Envía un mensaje breve al chat de WhatsApp. Solo si las respuestas están permitidas: confirmación corta o UNA pregunta imprescindible.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "Mensaje en castellano, breve y natural" } },
      required: ["text"],
    },
  },
];

export type ToolContext = {
  runId: number;
  chatId: number;
  chatJid: string;
  shadow: boolean;
  canReply: boolean;
  settings: AgentSettings;
};

const WRITE_TOOLS = new Set([
  "create_task",
  "update_task",
  "comment_task",
  "transition_task",
  "attach_media",
  "send_whatsapp_reply",
]);

const MEDIA_TYPES = new Set(["imageMessage", "videoMessage", "documentMessage"]);

/** Extensión por defecto según el mimetype, para nombrar el fichero subido. */
function extFor(mimetype: string): string {
  if (mimetype.includes("jpeg") || mimetype.includes("jpg")) return "jpg";
  if (mimetype.includes("png")) return "png";
  if (mimetype.includes("webp")) return "webp";
  if (mimetype.includes("gif")) return "gif";
  if (mimetype.includes("mp4")) return "mp4";
  if (mimetype.includes("quicktime") || mimetype.includes("mov")) return "mov";
  if (mimetype.includes("pdf")) return "pdf";
  const guess = mimetype.split("/")[1]?.split(";")[0];
  return guess && /^[a-z0-9]{1,5}$/i.test(guess) ? guess : "bin";
}

/** Notificación opcional a N8N de cada acción ejecutada (fase 4 del roadmap). */
function notifyN8n(payload: Record<string, unknown>): void {
  const url = loadConfig().N8N_EVENTS_WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "tdp-agente-tareas", at: new Date().toISOString(), ...payload }),
  }).catch((err) => log.warn("No se pudo notificar a N8N", err));
}

/** Cachea en task_links el ticket tocado — memoria anti-duplicados por chat. */
async function upsertTaskLink(
  ctx: ToolContext,
  taskKey: string,
  patch: { summary?: string; status?: string; priority?: string | null; assignee?: string | null },
  action: string,
): Promise<void> {
  const provider = getTaskProvider().name;
  const [existing] = await db
    .select()
    .from(schema.taskLinks)
    .where(
      and(
        eq(schema.taskLinks.chatId, ctx.chatId),
        eq(schema.taskLinks.provider, provider),
        eq(schema.taskLinks.taskKey, taskKey),
      ),
    )
    .limit(1);
  if (existing) {
    await db
      .update(schema.taskLinks)
      .set({
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
        lastAction: action,
        updatedAt: new Date(),
      })
      .where(eq(schema.taskLinks.id, existing.id));
  } else {
    await db.insert(schema.taskLinks).values({
      chatId: ctx.chatId,
      provider,
      taskKey,
      summary: patch.summary ?? "",
      status: patch.status ?? "",
      priority: patch.priority ?? null,
      assignee: patch.assignee ?? null,
      lastAction: action,
    });
  }
}

/**
 * Ejecuta una herramienta pedida por el agente y devuelve el resultado como
 * texto. Registra TODO en agent_actions. En modo shadow las herramientas de
 * escritura no tocan Jira/WhatsApp: devuelven una simulación etiquetada.
 */
export class ToolExecutor {
  private searchedThisRun = false;

  constructor(private readonly ctx: ToolContext) {}

  async execute(tool: string, input: Record<string, unknown>): Promise<{ result: string; isError: boolean }> {
    let result = "";
    let isError = false;
    let executed = false;
    let taskKey: string | null = typeof input.key === "string" ? input.key : null;

    try {
      const out = await this.dispatch(tool, input);
      result = out.result;
      executed = out.executed;
      taskKey = out.taskKey ?? taskKey;
    } catch (err) {
      isError = true;
      result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(`Herramienta ${tool} falló`, err);
    }

    await db.insert(schema.agentActions).values({
      runId: this.ctx.runId,
      chatId: this.ctx.chatId,
      tool,
      input,
      result: result.slice(0, 8000),
      ok: !isError,
      executed,
      taskKey,
    });

    if (executed && WRITE_TOOLS.has(tool)) {
      notifyN8n({ event: "agent.action", tool, taskKey, chatId: this.ctx.chatId, input });
    }

    return { result, isError };
  }

  private shadowResult(description: string): { result: string; executed: false } {
    return {
      result: `[MODO SHADOW — acción registrada pero NO ejecutada] ${description}. Continúa como si se hubiera aplicado.`,
      executed: false,
    };
  }

  private async dispatch(
    tool: string,
    input: Record<string, unknown>,
  ): Promise<{ result: string; executed: boolean; taskKey?: string | null }> {
    const provider = getTaskProvider();

    switch (tool) {
      case "search_tasks": {
        this.searchedThisRun = true;
        const results = await provider.searchTasks(String(input.text ?? ""), {
          includeDone: Boolean(input.include_done),
        });
        return {
          result: results.length
            ? JSON.stringify(results, null, 2)
            : "Sin resultados. Prueba otros términos antes de dar el asunto por inexistente.",
          executed: false,
        };
      }

      case "get_task": {
        const detail = await provider.getTask(String(input.key ?? ""));
        return { result: JSON.stringify(detail, null, 2), executed: false };
      }

      case "create_task": {
        if (!this.searchedThisRun) {
          throw new Error(
            "Antes de crear un ticket tienes que buscar con search_tasks para descartar duplicados.",
          );
        }
        const summary = String(input.summary ?? "").trim();
        const description = String(input.description ?? "").trim();
        if (!summary || !description) throw new Error("summary y description son obligatorios.");
        if (this.ctx.shadow) return this.shadowResult(`Se crearía el ticket "${summary}"`);
        const created = await provider.createTask({
          summary,
          description,
          priority: input.priority ? String(input.priority) : undefined,
          assigneeAccountId: input.assignee_account_id ? String(input.assignee_account_id) : undefined,
          labels: Array.isArray(input.labels) ? input.labels.map(String) : undefined,
        });
        await upsertTaskLink(
          this.ctx,
          created.key,
          { summary: created.summary, status: created.status, priority: created.priority, assignee: created.assignee },
          "created",
        );
        return { result: JSON.stringify(created, null, 2), executed: true, taskKey: created.key };
      }

      case "update_task": {
        const key = String(input.key ?? "");
        if (this.ctx.shadow) return this.shadowResult(`Se actualizaría ${key}`);
        await provider.updateTask(key, {
          summary: input.summary !== undefined ? String(input.summary) : undefined,
          description: input.description !== undefined ? String(input.description) : undefined,
          priority: input.priority !== undefined ? String(input.priority) : undefined,
          assigneeAccountId:
            input.assignee_account_id !== undefined ? String(input.assignee_account_id) : undefined,
          labels: Array.isArray(input.labels) ? input.labels.map(String) : undefined,
        });
        const updated = await provider.getTask(key);
        await upsertTaskLink(
          this.ctx,
          key,
          { summary: updated.summary, status: updated.status, priority: updated.priority, assignee: updated.assignee },
          "updated",
        );
        return { result: `Ticket ${key} actualizado.\n${JSON.stringify(updated, null, 2)}`, executed: true, taskKey: key };
      }

      case "comment_task": {
        const key = String(input.key ?? "");
        const body = String(input.body ?? "").trim();
        if (!body) throw new Error("body es obligatorio.");
        if (this.ctx.shadow) return this.shadowResult(`Se comentaría en ${key}: "${body.slice(0, 120)}…"`);
        await provider.addComment(key, body);
        await upsertTaskLink(this.ctx, key, {}, "commented");
        return { result: `Comentario añadido a ${key}.`, executed: true, taskKey: key };
      }

      case "transition_task": {
        const key = String(input.key ?? "");
        const target = String(input.target_status ?? "");
        if (this.ctx.shadow) return this.shadowResult(`Se movería ${key} a "${target}"`);
        const applied = await provider.transitionTask(key, target);
        await upsertTaskLink(this.ctx, key, { status: applied }, "transitioned");
        return { result: `Ticket ${key} movido a "${applied}".`, executed: true, taskKey: key };
      }

      case "attach_media": {
        const key = String(input.key ?? "");
        const ids = Array.isArray(input.media_ids)
          ? (input.media_ids as unknown[]).map(Number).filter((n) => Number.isInteger(n))
          : [];
        if (!key || ids.length === 0) throw new Error("key y media_ids son obligatorios.");

        // Solo mensajes de ESTE chat con adjunto descargable.
        const msgs = await db
          .select()
          .from(schema.messages)
          .where(and(eq(schema.messages.chatId, this.ctx.chatId), inArray(schema.messages.id, ids)));

        const files: MediaFile[] = [];
        for (const m of msgs) {
          if (!MEDIA_TYPES.has(m.type)) continue;
          const media = await getMediaBase64(m.waMessageId);
          if (!media) {
            log.warn(`No se pudo descargar el adjunto del mensaje ${m.id}`);
            continue;
          }
          const meta = (m.mediaMeta ?? {}) as { mimetype?: string; fileName?: string };
          const contentType = meta.mimetype || media.mimetype || "application/octet-stream";
          const filename = meta.fileName || `adjunto-${m.id}.${extFor(contentType)}`;
          files.push({ filename, contentType, data: Buffer.from(media.base64, "base64") });
        }
        if (files.length === 0) throw new Error("Ninguno de los mensajes indicados tiene un adjunto descargable.");

        if (this.ctx.shadow) {
          return this.shadowResult(`Se adjuntarían ${files.length} archivo(s) a ${key}`);
        }
        await getTaskProvider().attachMediaToTask(key, files);
        return { result: `${files.length} adjunto(s) subido(s) a ${key}.`, executed: true, taskKey: key };
      }

      case "send_whatsapp_reply": {
        const text = String(input.text ?? "").trim();
        if (!text) throw new Error("text es obligatorio.");
        if (!this.ctx.canReply) {
          throw new Error("Las respuestas por WhatsApp están desactivadas para este chat.");
        }
        if (this.ctx.shadow) return this.shadowResult(`Se enviaría al chat: "${text.slice(0, 160)}"`);
        await sendText(this.ctx.chatJid, text);
        return { result: "Mensaje enviado al chat.", executed: true };
      }

      default:
        throw new Error(`Herramienta desconocida: ${tool}`);
    }
  }
}
