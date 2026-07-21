import { eq, sql } from "drizzle-orm";
import { db, schema } from "./db/index.js";
import { logger } from "./log.js";
import { normalizeMessageEvent, type NormalizedMessage } from "./evolution/parse.js";
import { processMessageMedia } from "./media/process.js";
import { scheduleChat } from "./agent/batcher.js";
import { fetchAllGroups, findChats } from "./evolution/client.js";

const log = logger("ingest");

/** Crea el chat si no existe (sin monitorizar) y refresca nombre/última actividad. */
async function upsertChat(msg: NormalizedMessage, chatName?: string): Promise<number> {
  const isGroup = msg.chatJid.endsWith("@g.us");
  const [row] = await db
    .insert(schema.chats)
    .values({
      jid: msg.chatJid,
      name: chatName ?? "",
      isGroup,
      lastMessageAt: msg.sentAt,
    })
    .onConflictDoUpdate({
      target: schema.chats.jid,
      set: {
        lastMessageAt: msg.sentAt,
        updatedAt: new Date(),
        ...(chatName ? { name: chatName } : {}),
      },
    })
    .returning({ id: schema.chats.id, monitored: schema.chats.monitored });
  return row.monitored ? row.id : -row.id; // signo: -id = no monitorizado
}

async function upsertPerson(msg: NormalizedMessage): Promise<void> {
  if (!msg.senderJid || msg.fromMe) return;
  await db
    .insert(schema.people)
    .values({ jid: msg.senderJid, pushName: msg.pushName })
    .onConflictDoUpdate({
      target: schema.people.jid,
      set: {
        ...(msg.pushName ? { pushName: msg.pushName } : {}),
        updatedAt: new Date(),
      },
    });
}

/**
 * Punto de entrada de cada MESSAGES_UPSERT del webhook. Almacena solo el
 * contenido de chats monitorizados (privacidad: del resto solo se registra la
 * existencia del chat para poder activarlo desde el panel).
 */
export async function ingestMessageEvent(data: unknown, chatName?: string): Promise<void> {
  const msg = normalizeMessageEvent((data ?? {}) as Parameters<typeof normalizeMessageEvent>[0]);
  if (!msg) return;

  const signedChatId = await upsertChat(msg, chatName);
  if (signedChatId < 0) return; // chat sin monitorizar: no se guarda contenido
  const chatId = signedChatId;

  await upsertPerson(msg);

  const [inserted] = await db
    .insert(schema.messages)
    .values({
      chatId,
      waMessageId: msg.waMessageId,
      senderJid: msg.senderJid,
      pushName: msg.pushName,
      fromMe: msg.fromMe,
      type: msg.type,
      text: msg.text,
      quotedText: msg.quotedText,
      mediaStatus: msg.hasMedia ? "pending" : "none",
      mediaMeta: msg.mediaMeta,
      sentAt: msg.sentAt,
      // Lo enviado desde el propio número queda solo como contexto:
      processed: msg.fromMe,
    })
    .onConflictDoNothing({ target: [schema.messages.chatId, schema.messages.waMessageId] })
    .returning({ id: schema.messages.id });

  if (!inserted) return; // duplicado (Evolution reintenta webhooks)

  log.info(`Mensaje ${msg.type} de ${msg.pushName || msg.senderJid} en chat ${chatId}`);

  // El media se procesa en segundo plano; el batcher espera el debounce, así
  // que normalmente la transcripción está lista antes de ejecutar el agente.
  if (msg.hasMedia && !msg.fromMe) {
    processMessageMedia(inserted.id).catch((err) =>
      log.error(`Media del mensaje ${inserted.id} falló`, err),
    );
  }

  if (!msg.fromMe) await scheduleChat(chatId);
}

/**
 * Sincroniza el catálogo de chats/grupos desde Evolution (botón del panel):
 * da nombre a los grupos y hace visibles los chats aún sin mensajes.
 */
export async function syncChatsFromEvolution(): Promise<{ groups: number; chats: number }> {
  let groups = 0;
  let chats = 0;

  try {
    const list = await fetchAllGroups(false);
    for (const g of list) {
      if (!g.id) continue;
      await db
        .insert(schema.chats)
        .values({ jid: g.id, name: g.subject ?? "", isGroup: true })
        .onConflictDoUpdate({
          target: schema.chats.jid,
          set: { ...(g.subject ? { name: g.subject } : {}), updatedAt: new Date() },
        });
      groups++;
    }
  } catch (err) {
    log.warn("No se pudieron sincronizar los grupos", err);
  }

  try {
    const list = await findChats();
    for (const c of list) {
      const jid = c.remoteJid ?? c.id;
      if (!jid || jid === "status@broadcast") continue;
      const name = c.name ?? c.pushName ?? "";
      await db
        .insert(schema.chats)
        .values({ jid, name, isGroup: jid.endsWith("@g.us") })
        .onConflictDoUpdate({
          target: schema.chats.jid,
          set: { ...(name ? { name } : {}), updatedAt: new Date() },
        });
      chats++;
    }
  } catch (err) {
    log.warn("No se pudieron sincronizar los chats", err);
  }

  return { groups, chats };
}

/** Contadores para /admin/overview. */
export async function ingestStats(): Promise<{
  chats: number;
  monitored: number;
  messages: number;
  pendingMessages: number;
}> {
  const res = await db.execute<{
    chats: string;
    monitored: string;
    messages: string;
    pending: string;
  }>(sql`
    SELECT
      (SELECT count(*) FROM chats) AS chats,
      (SELECT count(*) FROM chats WHERE monitored) AS monitored,
      (SELECT count(*) FROM messages) AS messages,
      (SELECT count(*) FROM messages WHERE NOT processed AND NOT from_me) AS pending
  `);
  const row = res.rows[0];
  return {
    chats: Number(row?.chats ?? 0),
    monitored: Number(row?.monitored ?? 0),
    messages: Number(row?.messages ?? 0),
    pendingMessages: Number(row?.pending ?? 0),
  };
}
