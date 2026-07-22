import { z } from "zod";

/**
 * Configuración por entorno. Secretos y conexión SIEMPRE por env (Coolify);
 * el comportamiento en caliente (modo, debounce, instrucciones extra…) vive en
 * BD y se edita desde TDP Gestión (ver settings.ts).
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  DATABASE_URL: z.string().min(1, "Falta DATABASE_URL"),
  DATABASE_CA_CERT: z.string().optional(),

  /** Evolution API: instancia de WhatsApp ya conectada (QR escaneado). */
  EVOLUTION_API_URL: z.string().url("EVOLUTION_API_URL debe ser una URL"),
  EVOLUTION_API_KEY: z.string().min(1, "Falta EVOLUTION_API_KEY"),
  EVOLUTION_INSTANCE: z.string().min(1, "Falta EVOLUTION_INSTANCE"),

  /** Token que Evolution debe mandar en el webhook (header x-agent-token o ?token=). */
  AGENT_WEBHOOK_TOKEN: z.string().min(16, "AGENT_WEBHOOK_TOKEN mínimo 16 chars"),
  /** Bearer con el que TDP Gestión llama a la API /admin. */
  AGENT_ADMIN_TOKEN: z.string().min(16, "AGENT_ADMIN_TOKEN mínimo 16 chars"),

  ANTHROPIC_API_KEY: z.string().min(1, "Falta ANTHROPIC_API_KEY"),
  /** Modelo del agente principal (razonamiento + herramientas). */
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),
  /** Modelo barato para describir imágenes/fotogramas de vídeo. */
  ANTHROPIC_MEDIA_MODEL: z.string().default("claude-haiku-4-5-20251001"),

  /**
   * Transcripción de notas de voz/audio de vídeos: cualquier API compatible con
   * OpenAI (/audio/transcriptions): OpenAI, Groq, faster-whisper local…
   * Sin STT_API_KEY el agente sigue funcionando pero sin transcribir audios.
   */
  STT_API_URL: z.string().url().default("https://api.openai.com/v1"),
  STT_API_KEY: z.string().optional(),
  STT_MODEL: z.string().default("whisper-1"),

  /**
   * Proveedor de tareas. Cada uno solo exige SUS variables (ver superRefine).
   *  - jira:   JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN / JIRA_PROJECT_KEY
   *  - linear: LINEAR_API_KEY / LINEAR_TEAM_KEY
   */
  TASK_PROVIDER: z.enum(["jira", "linear"]).default("jira"),

  // --- Jira Cloud ---
  JIRA_BASE_URL: z.string().url("JIRA_BASE_URL debe ser una URL (https://xxx.atlassian.net)").optional(),
  JIRA_EMAIL: z.string().optional(),
  JIRA_API_TOKEN: z.string().optional(),
  JIRA_PROJECT_KEY: z.string().optional(),
  JIRA_ISSUE_TYPE: z.string().default("Task"),

  // --- Linear ---
  LINEAR_API_URL: z.string().url().default("https://api.linear.app/graphql"),
  /** Personal API key (Settings → Security & access → Personal API keys). */
  LINEAR_API_KEY: z.string().optional(),
  /** Clave del equipo donde crear los issues (p. ej. "TDP"); se ve en la URL/ajustes del team. */
  LINEAR_TEAM_KEY: z.string().optional(),

  /** Opcional: webhook de N8N al que se notifican las acciones del agente (fase 4 del roadmap). */
  N8N_EVENTS_WEBHOOK_URL: z.string().url().optional(),

  /** Directorio de trabajo para media temporal (frames/audio de vídeos). */
  DATA_DIR: z.string().default("/data"),
}).superRefine((val, ctx) => {
  if (val.TASK_PROVIDER === "jira") {
    if (!val.JIRA_BASE_URL) ctx.addIssue({ code: "custom", path: ["JIRA_BASE_URL"], message: "obligatorio con TASK_PROVIDER=jira" });
    if (!val.JIRA_EMAIL) ctx.addIssue({ code: "custom", path: ["JIRA_EMAIL"], message: "obligatorio con TASK_PROVIDER=jira" });
    if (!val.JIRA_API_TOKEN) ctx.addIssue({ code: "custom", path: ["JIRA_API_TOKEN"], message: "obligatorio con TASK_PROVIDER=jira" });
    if (!val.JIRA_PROJECT_KEY) ctx.addIssue({ code: "custom", path: ["JIRA_PROJECT_KEY"], message: "obligatorio con TASK_PROVIDER=jira" });
  } else if (val.TASK_PROVIDER === "linear") {
    if (!val.LINEAR_API_KEY) ctx.addIssue({ code: "custom", path: ["LINEAR_API_KEY"], message: "obligatorio con TASK_PROVIDER=linear" });
    if (!val.LINEAR_TEAM_KEY) ctx.addIssue({ code: "custom", path: ["LINEAR_TEAM_KEY"], message: "obligatorio con TASK_PROVIDER=linear" });
  }
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Normaliza el entorno antes de validar: trata como "no definido" los valores
 * vacíos y los que llegan como comillas literales (`''` / `""`). Coolify vuelca
 * las variables sin valor del compose como cadena vacía o `''`, y sin esto una
 * opcional-URL vacía (p. ej. N8N_EVENTS_WEBHOOK_URL) rompería el arranque.
 */
function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === "''" || trimmed === '""') out[key] = undefined;
  }
  return out;
}

export function loadConfig(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(sanitizeEnv(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuración inválida:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
