/** Logger mínimo con prefijo de módulo y timestamp ISO (stdout → Coolify). */

type Level = "info" | "warn" | "error";

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} [${scope}] ${message}`;
  const args: unknown[] = [line];
  if (extra !== undefined) args.push(extra);
  if (level === "error") console.error(...args);
  else if (level === "warn") console.warn(...args);
  else console.log(...args);
}

export function logger(scope: string) {
  return {
    info: (message: string, extra?: unknown) => write("info", scope, message, extra),
    warn: (message: string, extra?: unknown) => write("warn", scope, message, extra),
    error: (message: string, extra?: unknown) => write("error", scope, message, extra),
  };
}
