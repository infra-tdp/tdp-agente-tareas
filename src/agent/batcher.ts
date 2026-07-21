import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { logger } from "../log.js";
import { getSettings } from "../settings.js";
import { runAgentForChat } from "./run.js";

const log = logger("batcher");

/**
 * Debounce por chat: Raúl escribe en ráfagas (varias notas de voz seguidas),
 * así que se espera a `debounceSeconds` de silencio antes de procesar, con un
 * tope de `maxBatchWaitSeconds` desde el primer mensaje pendiente. Las
 * ejecuciones son secuenciales (una réplica, sin colas externas — misma
 * decisión que el scheduler de tdp-gestion-app).
 */

type PendingChat = { timer: NodeJS.Timeout; firstMessageAt: number };

const pendingByChat = new Map<number, PendingChat>();
let queue: Promise<void> = Promise.resolve();

function enqueueRun(chatId: number): void {
  pendingByChat.delete(chatId);
  queue = queue
    .then(() => runAgentForChat(chatId))
    .catch((err) => log.error(`Ejecución del chat ${chatId} falló`, err));
}

/** Llamar cada vez que entra un mensaje procesable de un chat monitorizado. */
export async function scheduleChat(chatId: number): Promise<void> {
  const settings = await getSettings();
  const now = Date.now();
  const existing = pendingByChat.get(chatId);
  const firstMessageAt = existing?.firstMessageAt ?? now;

  if (existing) clearTimeout(existing.timer);

  const elapsed = now - firstMessageAt;
  const maxWaitMs = settings.maxBatchWaitSeconds * 1000;
  const debounceMs = settings.debounceSeconds * 1000;
  const delay = Math.max(0, Math.min(debounceMs, maxWaitMs - elapsed));

  const timer = setTimeout(() => enqueueRun(chatId), delay);
  timer.unref?.();
  pendingByChat.set(chatId, { timer, firstMessageAt });
}

/** Fuerza el procesado inmediato de un chat (botón "Procesar ahora" del panel). */
export function forceRun(chatId: number): void {
  const existing = pendingByChat.get(chatId);
  if (existing) clearTimeout(existing.timer);
  enqueueRun(chatId);
}

/** Al arrancar: reprograma los chats que quedaron con mensajes sin procesar. */
export async function recoverPending(): Promise<void> {
  const rows = await db
    .selectDistinct({ chatId: schema.messages.chatId })
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatId, schema.chats.id))
    .where(
      and(
        eq(schema.messages.processed, false),
        eq(schema.messages.fromMe, false),
        eq(schema.chats.monitored, true),
      ),
    );
  for (const row of rows) {
    log.info(`Recuperando chat ${row.chatId} con mensajes pendientes`);
    await scheduleChat(row.chatId);
  }
}
