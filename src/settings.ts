import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db/index.js";

/**
 * Ajustes en caliente del agente (BD, editables desde TDP Gestión).
 * Todo lo que sea secreto o de conexión va por env (config.ts) — aquí solo
 * comportamiento, con defaults seguros: modo shadow y sin respuestas.
 */
export const SettingsSchema = z.object({
  /**
   * shadow: el agente razona, busca en Jira y REGISTRA lo que haría, pero no
   * escribe en Jira ni en WhatsApp. Para validar antes de soltarlo. active:
   * ejecuta de verdad.
   */
  mode: z.enum(["shadow", "active"]).default("shadow"),
  /** Segundos de silencio en el chat antes de procesar el lote (Raúl escribe en ráfagas). */
  debounceSeconds: z.number().int().min(10).max(1800).default(90),
  /** Tope de espera desde el primer mensaje pendiente aunque sigan llegando. */
  maxBatchWaitSeconds: z.number().int().min(60).max(3600).default(600),
  /** Mensajes de historial que se pasan como contexto en cada ejecución. */
  historyLimit: z.number().int().min(10).max(200).default(60),
  /** Permitir respuestas por WhatsApp (además del allowReplies por chat). */
  repliesEnabled: z.boolean().default(false),
  /** Instrucciones extra del negocio, editables desde el panel. */
  extraInstructions: z.string().default(""),
});

export type AgentSettings = z.infer<typeof SettingsSchema>;

const KEY = "agent.settings";

let cache: AgentSettings | null = null;

export async function getSettings(): Promise<AgentSettings> {
  if (cache) return cache;
  try {
    const [row] = await db
      .select()
      .from(schema.agentSettings)
      .where(eq(schema.agentSettings.key, KEY))
      .limit(1);
    cache = SettingsSchema.parse(row?.value ?? {});
  } catch {
    cache = SettingsSchema.parse({});
  }
  return cache;
}

export async function updateSettings(patch: Partial<AgentSettings>): Promise<AgentSettings> {
  // Fusionar SIEMPRE contra el valor fresco de BD (no la caché en memoria) y
  // aplicar SOLO las claves realmente definidas del patch. Así, guardar una
  // sección del panel (p. ej. ajustes) nunca pisa los campos de otra (contexto),
  // aunque el patch parcial traiga claves undefined.
  let currentRaw: unknown = {};
  try {
    const [row] = await db
      .select()
      .from(schema.agentSettings)
      .where(eq(schema.agentSettings.key, KEY))
      .limit(1);
    currentRaw = row?.value ?? {};
  } catch {
    /* BD no lista: se parte de defaults */
  }
  const current = SettingsSchema.parse(currentRaw);
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<AgentSettings>;
  const next = SettingsSchema.parse({ ...current, ...clean });

  await db
    .insert(schema.agentSettings)
    .values({ key: KEY, value: next })
    .onConflictDoUpdate({
      target: schema.agentSettings.key,
      set: { value: next, updatedAt: new Date() },
    });
  cache = next;
  return next;
}
