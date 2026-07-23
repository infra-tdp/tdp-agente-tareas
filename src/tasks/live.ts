import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { logger } from "../log.js";
import { getTaskProvider } from "./index.js";

const log = logger("live");

type TaskLinkRow = typeof schema.taskLinks.$inferSelect;
export type EnrichedLink = TaskLinkRow & { done: boolean; url: string | null };

/**
 * Refresca en task_links el estado REAL (del gestor) de los tickets dados y
 * devuelve la lista enriquecida con `done`/`url`. Mantiene el panel y el
 * contexto del agente "en vivo" con Linear/Jira aunque un ticket se cierre a
 * mano. Una sola llamada al proveedor (batch). Si el proveedor falla, devuelve
 * la caché tal cual (done=false) para no romper la vista.
 */
export async function refreshLinks(rows: TaskLinkRow[]): Promise<EnrichedLink[]> {
  if (rows.length === 0) return [];
  const keys = Array.from(new Set(rows.map((r) => r.taskKey)));
  let live;
  try {
    live = await getTaskProvider().getTasksByKeys(keys);
  } catch (err) {
    log.warn("No se pudo refrescar el estado de los tickets", err);
    return rows.map((r) => ({ ...r, done: false, url: null }));
  }
  const byKey = new Map(live.map((t) => [t.key, t]));

  const out: EnrichedLink[] = [];
  for (const r of rows) {
    const t = byKey.get(r.taskKey);
    if (!t) {
      // El ticket ya no existe en el gestor (borrado): se conserva la caché.
      out.push({ ...r, done: false, url: null });
      continue;
    }
    // Actualiza la caché solo si algo cambió (evita escrituras innecesarias).
    if (
      t.status !== r.status ||
      (t.priority ?? null) !== r.priority ||
      (t.assignee ?? null) !== r.assignee ||
      t.summary !== r.summary
    ) {
      await db
        .update(schema.taskLinks)
        .set({
          status: t.status,
          priority: t.priority ?? null,
          assignee: t.assignee ?? null,
          summary: t.summary,
          updatedAt: new Date(),
        })
        .where(eq(schema.taskLinks.id, r.id));
    }
    out.push({
      ...r,
      status: t.status,
      priority: t.priority ?? null,
      assignee: t.assignee ?? null,
      summary: t.summary,
      done: t.done,
      url: t.url,
    });
  }
  return out;
}

/** Refresca (en BD) el estado de todos los tickets vinculados a un chat. */
export async function refreshChatLinks(chatId: number): Promise<void> {
  const rows = await db
    .select()
    .from(schema.taskLinks)
    .where(eq(schema.taskLinks.chatId, chatId));
  await refreshLinks(rows);
}
