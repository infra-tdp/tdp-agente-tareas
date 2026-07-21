import { loadConfig } from "../config.js";
import { logger } from "../log.js";

const log = logger("evolution");

/**
 * Cliente REST de Evolution API (v2) contra UNA instancia (un número de
 * WhatsApp). La instancia se crea/escanea desde el manager de Evolution; aquí
 * solo se consume: estado, chats/grupos, descarga de media y envío de texto.
 */

export type EvoGroup = {
  id: string;
  subject: string;
  size?: number;
  participants?: { id: string; admin?: string | null }[];
};

export type EvoChat = {
  id?: string;
  remoteJid?: string;
  name?: string;
  pushName?: string;
};

async function evoFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = loadConfig();
  const url = `${cfg.EVOLUTION_API_URL.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: cfg.EVOLUTION_API_KEY,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Evolution ${path} → HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** Estado de conexión de la instancia ("open" = WhatsApp conectado). */
export async function connectionState(): Promise<string> {
  const cfg = loadConfig();
  try {
    const data = await evoFetch<{ instance?: { state?: string } }>(
      `/instance/connectionState/${encodeURIComponent(cfg.EVOLUTION_INSTANCE)}`,
    );
    return data.instance?.state ?? "unknown";
  } catch (err) {
    log.warn("No se pudo leer el estado de la instancia", err);
    return "unreachable";
  }
}

/** Todos los grupos de la cuenta (sin participantes: es la llamada pesada). */
export async function fetchAllGroups(withParticipants = false): Promise<EvoGroup[]> {
  const cfg = loadConfig();
  const data = await evoFetch<EvoGroup[]>(
    `/group/fetchAllGroups/${encodeURIComponent(cfg.EVOLUTION_INSTANCE)}?getParticipants=${withParticipants}`,
  );
  return Array.isArray(data) ? data : [];
}

/** Participantes de un grupo concreto. */
export async function groupParticipants(groupJid: string): Promise<{ id: string }[]> {
  const cfg = loadConfig();
  const data = await evoFetch<{ participants?: { id: string }[] }>(
    `/group/participants/${encodeURIComponent(cfg.EVOLUTION_INSTANCE)}?groupJid=${encodeURIComponent(groupJid)}`,
  );
  return data.participants ?? [];
}

/** Chats conocidos por la instancia (incluye directos). */
export async function findChats(): Promise<EvoChat[]> {
  const cfg = loadConfig();
  const data = await evoFetch<EvoChat[]>(
    `/chat/findChats/${encodeURIComponent(cfg.EVOLUTION_INSTANCE)}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return Array.isArray(data) ? data : [];
}

/**
 * Descarga el media de un mensaje en base64 (Evolution lo pide a WhatsApp).
 * Devuelve null si Evolution no puede recuperarlo (mensaje viejo, etc.).
 */
export async function getMediaBase64(
  waMessageId: string,
): Promise<{ base64: string; mimetype: string } | null> {
  const cfg = loadConfig();
  try {
    const data = await evoFetch<{ base64?: string; mimetype?: string; media?: string }>(
      `/chat/getBase64FromMediaMessage/${encodeURIComponent(cfg.EVOLUTION_INSTANCE)}`,
      {
        method: "POST",
        body: JSON.stringify({ message: { key: { id: waMessageId } }, convertToMp4: false }),
      },
    );
    const base64 = data.base64 ?? data.media;
    if (!base64) return null;
    return { base64, mimetype: data.mimetype ?? "application/octet-stream" };
  } catch (err) {
    log.warn(`No se pudo descargar media del mensaje ${waMessageId}`, err);
    return null;
  }
}

/** Envía un texto a un chat (jid de grupo o directo). */
export async function sendText(jid: string, text: string): Promise<void> {
  const cfg = loadConfig();
  await evoFetch(`/message/sendText/${encodeURIComponent(cfg.EVOLUTION_INSTANCE)}`, {
    method: "POST",
    body: JSON.stringify({ number: jid, text }),
  });
}
