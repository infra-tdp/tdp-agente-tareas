import { loadConfig } from "../config.js";
import { logger } from "../log.js";

const log = logger("stt");

/**
 * Transcripción de audio contra cualquier API compatible con OpenAI
 * (POST {STT_API_URL}/audio/transcriptions): OpenAI, Groq, faster-whisper…
 * Devuelve null si no hay STT configurado o falla (el agente degrada a
 * "[nota de voz sin transcribir]").
 */
export async function transcribeAudio(
  audio: Buffer,
  mimetype: string,
  language = "es",
): Promise<string | null> {
  const cfg = loadConfig();
  if (!cfg.STT_API_KEY) return null;

  const ext = mimetype.includes("ogg")
    ? "ogg"
    : mimetype.includes("mp4") || mimetype.includes("m4a")
      ? "m4a"
      : mimetype.includes("mpeg") || mimetype.includes("mp3")
        ? "mp3"
        : mimetype.includes("wav")
          ? "wav"
          : "ogg";

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimetype }), `audio.${ext}`);
  form.append("model", cfg.STT_MODEL);
  form.append("language", language);
  form.append("response_format", "json");

  try {
    const res = await fetch(`${cfg.STT_API_URL.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.STT_API_KEY}` },
      body: form,
    });
    if (!res.ok) {
      log.warn(`STT HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch (err) {
    log.warn("Fallo transcribiendo audio", err);
    return null;
  }
}
