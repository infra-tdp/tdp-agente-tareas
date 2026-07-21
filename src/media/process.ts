import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { loadConfig } from "../config.js";
import { logger } from "../log.js";
import { getMediaBase64 } from "../evolution/client.js";
import { transcribeAudio } from "./stt.js";
import { extractFromVideo } from "./ffmpeg.js";

const log = logger("media");

let anthropic: Anthropic | null = null;
function client(): Anthropic {
  if (!anthropic) anthropic = new Anthropic({ apiKey: loadConfig().ANTHROPIC_API_KEY });
  return anthropic;
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function toImageMediaType(mimetype: string): ImageMediaType {
  if (mimetype.includes("png")) return "image/png";
  if (mimetype.includes("gif")) return "image/gif";
  if (mimetype.includes("webp")) return "image/webp";
  return "image/jpeg";
}

/** Descripción corta de imágenes/fotogramas con el modelo barato de visión. */
async function describeImages(
  images: { base64: string; mimetype: string }[],
  hint: string,
): Promise<string | null> {
  const cfg = loadConfig();
  if (images.length === 0) return null;
  try {
    const res = await client().messages.create({
      model: cfg.ANTHROPIC_MEDIA_MODEL,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            ...images.map(
              (img) =>
                ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: toImageMediaType(img.mimetype),
                    data: img.base64,
                  },
                }),
            ),
            {
              type: "text",
              text:
                `${hint} Describe en castellano, en 2-4 frases, lo que se ve y cualquier ` +
                `texto legible. Es material de trabajo de un taller de patinetes eléctricos ` +
                `(averías, piezas, pantallas, albaranes…). Sé concreto y literal.`,
            },
          ],
        },
      ],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return text || null;
  } catch (err) {
    log.warn("Fallo describiendo imagen/fotogramas", err);
    return null;
  }
}

/**
 * Convierte el media de un mensaje en texto (`transcript`):
 *  - audio  → transcripción STT
 *  - imagen → descripción por visión
 *  - vídeo  → transcripción de su audio + descripción de fotogramas
 *  - documento → se queda con nombre/caption (ya en `text`)
 * Nunca lanza: deja mediaStatus done/error y sigue — el agente trabaja con lo que haya.
 */
export async function processMessageMedia(messageId: number): Promise<void> {
  const [msg] = await db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).limit(1);
  if (!msg || msg.mediaStatus !== "pending") return;

  const meta = (msg.mediaMeta ?? {}) as { mimetype?: string };
  let transcript: string | null = null;
  let ok = true;

  try {
    if (msg.type === "documentMessage") {
      transcript = null; // nombre de fichero/caption ya están en text
    } else {
      const media = await getMediaBase64(msg.waMessageId);
      if (!media) {
        transcript = "[no se pudo descargar el adjunto]";
        ok = false;
      } else if (msg.type === "audioMessage") {
        const buf = Buffer.from(media.base64, "base64");
        const text = await transcribeAudio(buf, meta.mimetype ?? media.mimetype);
        transcript = text ? `[transcripción de nota de voz] ${text}` : "[nota de voz sin transcribir]";
        ok = Boolean(text);
      } else if (msg.type === "imageMessage") {
        const desc = await describeImages(
          [{ base64: media.base64, mimetype: meta.mimetype ?? media.mimetype }],
          "Esta imagen se ha enviado a un grupo de trabajo por WhatsApp.",
        );
        transcript = desc ? `[descripción de imagen] ${desc}` : "[imagen sin describir]";
        ok = Boolean(desc);
      } else if (msg.type === "videoMessage") {
        const buf = Buffer.from(media.base64, "base64");
        const { audio, frames } = await extractFromVideo(buf);
        const parts: string[] = [];
        if (audio) {
          const text = await transcribeAudio(audio, "audio/mpeg");
          if (text) parts.push(`[audio del vídeo] ${text}`);
        }
        if (frames.length > 0) {
          const desc = await describeImages(
            frames.map((f) => ({ base64: f.toString("base64"), mimetype: "image/jpeg" })),
            `Son ${frames.length} fotogramas en orden de un vídeo enviado a un grupo de trabajo.`,
          );
          if (desc) parts.push(`[imágenes del vídeo] ${desc}`);
        }
        transcript = parts.length > 0 ? parts.join("\n") : "[vídeo sin procesar]";
        ok = parts.length > 0;
      }
    }
  } catch (err) {
    log.error(`Error procesando media del mensaje ${messageId}`, err);
    transcript = "[error procesando el adjunto]";
    ok = false;
  }

  await db
    .update(schema.messages)
    .set({ transcript, mediaStatus: ok ? "done" : "error" })
    .where(eq(schema.messages.id, messageId));
}
