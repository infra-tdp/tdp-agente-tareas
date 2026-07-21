import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { AgentSettings } from "../settings.js";

/**
 * Construcción del mensaje de usuario para cada ejecución: historial reciente
 * del chat, mapeo de personas, tickets ya vinculados y el lote de mensajes
 * nuevos claramente marcado.
 */

type Msg = typeof schema.messages.$inferSelect;

function shortJid(jid: string): string {
  return jid.split("@")[0] ?? jid;
}

function renderMessage(msg: Msg, isNew: boolean): string {
  const time = msg.sentAt.toLocaleString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Madrid",
  });
  const who = msg.fromMe ? "YO (número del agente)" : msg.pushName || shortJid(msg.senderJid);
  const marker = isNew ? ">>> NUEVO " : "";
  const lines: string[] = [];
  const header = `${marker}[${time}] ${who} (${shortJid(msg.senderJid)}) · ${msg.type}`;
  lines.push(header);
  if (msg.quotedText) lines.push(`  (en respuesta a: "${msg.quotedText.slice(0, 200)}")`);
  if (msg.text) lines.push(`  ${msg.text}`);
  if (msg.transcript) lines.push(`  ${msg.transcript}`);
  if (!msg.text && !msg.transcript) lines.push(`  [${msg.type} sin contenido de texto]`);
  return lines.join("\n");
}

export async function buildUserContext(opts: {
  chatId: number;
  settings: AgentSettings;
  batchIds: number[];
}): Promise<string> {
  const { chatId, settings, batchIds } = opts;
  const batchSet = new Set(batchIds);

  const history = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.chatId, chatId))
    .orderBy(desc(schema.messages.sentAt), desc(schema.messages.id))
    .limit(settings.historyLimit);
  history.reverse();

  // Personas vistas en este chat (autores del historial) + todas las mapeadas
  const senderJids = Array.from(new Set(history.map((m) => m.senderJid).filter(Boolean)));
  const persons = senderJids.length
    ? await db.select().from(schema.people).where(inArray(schema.people.jid, senderJids))
    : [];

  const links = await db
    .select()
    .from(schema.taskLinks)
    .where(and(eq(schema.taskLinks.chatId, chatId)))
    .orderBy(asc(schema.taskLinks.updatedAt));

  const sections: string[] = [];

  sections.push(
    "PERSONAS DEL CHAT (mapeo WhatsApp → gestor de tareas; configurado en el panel):\n" +
      (persons.length
        ? persons
            .map((p) => {
              const name = p.displayName || p.pushName || shortJid(p.jid);
              const acc = p.taskAccountId ? `accountId=${p.taskAccountId}` : "SIN MAPEAR (no asignable)";
              const alias = p.aliases ? ` · alias: ${p.aliases}` : "";
              return `- ${name} (${shortJid(p.jid)}) → ${acc}${alias}`;
            })
            .join("\n")
        : "- (sin personas registradas todavía)"),
  );

  sections.push(
    "TICKETS YA VINCULADOS A ESTE CHAT (creados o tocados por ti antes — revisa aquí ANTES de crear nada):\n" +
      (links.length
        ? links
            .map(
              (l) =>
                `- ${l.taskKey} [${l.status || "?"}]${l.priority ? ` · prioridad ${l.priority}` : ""}${
                  l.assignee ? ` · asignado a ${l.assignee}` : ""
                } — ${l.summary || "(sin resumen)"} (última acción: ${l.lastAction})`,
            )
            .join("\n")
        : "- (ninguno todavía)"),
  );

  const historyBlock = history
    .filter((m) => !batchSet.has(m.id))
    .map((m) => renderMessage(m, false))
    .join("\n");
  sections.push("HISTORIAL RECIENTE DEL CHAT (solo contexto, ya procesado):\n" + (historyBlock || "(vacío)"));

  const batch = history.filter((m) => batchSet.has(m.id));
  // Por si el lote es más viejo que la ventana de historial (no debería):
  const missingIds = batchIds.filter((id) => !batch.some((m) => m.id === id));
  if (missingIds.length) {
    const extra = await db.select().from(schema.messages).where(inArray(schema.messages.id, missingIds));
    batch.push(...extra);
    batch.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  }
  sections.push(
    "MENSAJES NUEVOS A PROCESAR AHORA:\n" + batch.map((m) => renderMessage(m, true)).join("\n"),
  );

  sections.push(
    "Analiza los mensajes nuevos con el contexto anterior y actúa según tus reglas. Termina con el resumen de auditoría.",
  );

  return sections.join("\n\n");
}
