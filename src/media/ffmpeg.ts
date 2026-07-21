import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { logger } from "../log.js";

const execFileAsync = promisify(execFile);
const log = logger("ffmpeg");

let ffmpegAvailable: boolean | null = null;

/** ffmpeg viene en la imagen Docker; en local puede faltar → degradación limpia. */
export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    ffmpegAvailable = true;
  } catch {
    log.warn("ffmpeg no disponible: los vídeos se procesarán solo con su caption");
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

/**
 * De un vídeo: pista de audio como mp3 (para STT) y hasta `frameCount`
 * fotogramas jpeg repartidos (para describir con visión).
 */
export async function extractFromVideo(
  video: Buffer,
  frameCount = 4,
): Promise<{ audio: Buffer | null; frames: Buffer[] }> {
  if (!(await hasFfmpeg())) return { audio: null, frames: [] };

  const dir = await mkdtemp(join(tmpdir(), "tdp-video-"));
  const input = join(dir, "input");
  try {
    await writeFile(input, video);

    let audio: Buffer | null = null;
    try {
      const audioPath = join(dir, "audio.mp3");
      await execFileAsync("ffmpeg", ["-i", input, "-vn", "-acodec", "libmp3lame", "-b:a", "64k", "-y", audioPath], {
        timeout: 120_000,
      });
      audio = await readFile(audioPath);
    } catch {
      /* vídeo sin pista de audio */
    }

    const frames: Buffer[] = [];
    try {
      // 1 fotograma cada N segundos, limitado a frameCount, reescalado a 640px
      await execFileAsync(
        "ffmpeg",
        ["-i", input, "-vf", "fps=1/5,scale=640:-2", "-frames:v", String(frameCount), "-q:v", "5", "-y", join(dir, "frame-%02d.jpg")],
        { timeout: 120_000 },
      );
      const files = (await readdir(dir)).filter((f) => f.startsWith("frame-")).sort();
      for (const f of files) frames.push(await readFile(join(dir, f)));
    } catch (err) {
      log.warn("No se pudieron extraer fotogramas", err);
    }

    return { audio, frames };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
