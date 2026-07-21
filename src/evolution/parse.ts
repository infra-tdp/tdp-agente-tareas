/**
 * Normalización de los eventos MESSAGES_UPSERT de Evolution API a un mensaje
 * plano con el que trabaja el resto del servicio. Evolution reenvía la
 * estructura de Baileys, con el contenido real a veces envuelto en
 * ephemeral/viewOnce.
 */

export type NormalizedMessage = {
  chatJid: string;
  waMessageId: string;
  senderJid: string;
  pushName: string;
  fromMe: boolean;
  type: string;
  text: string;
  quotedText: string | null;
  hasMedia: boolean;
  mediaKind: "audio" | "image" | "video" | "document" | null;
  mediaMeta: Record<string, unknown> | null;
  sentAt: Date;
};

type WebhookData = {
  key?: { remoteJid?: string; fromMe?: boolean; id?: string; participant?: string };
  pushName?: string;
  message?: Record<string, unknown> | null;
  messageType?: string;
  messageTimestamp?: number | string;
};

/** Quita envoltorios (ephemeral, viewOnce, documentWithCaption…) hasta el contenido real. */
function unwrap(message: Record<string, unknown>): Record<string, unknown> {
  let current = message;
  for (let i = 0; i < 4; i++) {
    const wrapper =
      (current.ephemeralMessage as { message?: Record<string, unknown> } | undefined) ??
      (current.viewOnceMessage as { message?: Record<string, unknown> } | undefined) ??
      (current.viewOnceMessageV2 as { message?: Record<string, unknown> } | undefined) ??
      (current.documentWithCaptionMessage as { message?: Record<string, unknown> } | undefined);
    if (wrapper?.message) current = wrapper.message;
    else break;
  }
  return current;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Devuelve null para eventos sin contenido útil (reacciones, borrados,
 * actualizaciones de protocolo, encuestas…): no se almacenan.
 */
export function normalizeMessageEvent(data: WebhookData): NormalizedMessage | null {
  const chatJid = data.key?.remoteJid ?? "";
  const waMessageId = data.key?.id ?? "";
  if (!chatJid || !waMessageId || !data.message) return null;

  const msg = unwrap(data.message);
  const sentAt = new Date(Number(data.messageTimestamp ?? 0) * 1000 || Date.now());
  const base = {
    chatJid,
    waMessageId,
    senderJid: data.key?.participant ?? (data.key?.fromMe ? "" : chatJid),
    pushName: data.pushName ?? "",
    fromMe: data.key?.fromMe ?? false,
    quotedText: null as string | null,
    sentAt,
  };

  const contextInfo = (
    Object.values(msg).find(
      (v) => typeof v === "object" && v !== null && "contextInfo" in (v as object),
    ) as { contextInfo?: { quotedMessage?: Record<string, unknown> } } | undefined
  )?.contextInfo;
  if (contextInfo?.quotedMessage) {
    const quoted = unwrap(contextInfo.quotedMessage);
    base.quotedText =
      str(quoted.conversation) ||
      str((quoted.extendedTextMessage as { text?: string } | undefined)?.text) ||
      str((quoted.imageMessage as { caption?: string } | undefined)?.caption) ||
      str((quoted.videoMessage as { caption?: string } | undefined)?.caption) ||
      (quoted.audioMessage ? "[nota de voz]" : null);
  }

  if (typeof msg.conversation === "string" && msg.conversation) {
    return { ...base, type: "conversation", text: msg.conversation, hasMedia: false, mediaKind: null, mediaMeta: null };
  }
  const extended = msg.extendedTextMessage as { text?: string } | undefined;
  if (extended?.text) {
    return { ...base, type: "extendedTextMessage", text: extended.text, hasMedia: false, mediaKind: null, mediaMeta: null };
  }
  const audio = msg.audioMessage as { mimetype?: string; seconds?: number; ptt?: boolean } | undefined;
  if (audio) {
    return {
      ...base,
      type: "audioMessage",
      text: "",
      hasMedia: true,
      mediaKind: "audio",
      mediaMeta: { mimetype: audio.mimetype, seconds: audio.seconds, ptt: audio.ptt },
    };
  }
  const image = msg.imageMessage as { caption?: string; mimetype?: string } | undefined;
  if (image) {
    return {
      ...base,
      type: "imageMessage",
      text: image.caption ?? "",
      hasMedia: true,
      mediaKind: "image",
      mediaMeta: { mimetype: image.mimetype },
    };
  }
  const video = msg.videoMessage as { caption?: string; mimetype?: string; seconds?: number } | undefined;
  if (video) {
    return {
      ...base,
      type: "videoMessage",
      text: video.caption ?? "",
      hasMedia: true,
      mediaKind: "video",
      mediaMeta: { mimetype: video.mimetype, seconds: video.seconds },
    };
  }
  const doc = msg.documentMessage as { caption?: string; fileName?: string; mimetype?: string } | undefined;
  if (doc) {
    return {
      ...base,
      type: "documentMessage",
      text: [doc.fileName, doc.caption].filter(Boolean).join(" — "),
      hasMedia: true,
      mediaKind: "document",
      mediaMeta: { mimetype: doc.mimetype, fileName: doc.fileName },
    };
  }
  const sticker = msg.stickerMessage;
  if (sticker) {
    return { ...base, type: "stickerMessage", text: "[sticker]", hasMedia: false, mediaKind: null, mediaMeta: null };
  }
  return null;
}
