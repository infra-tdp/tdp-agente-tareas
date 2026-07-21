import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

/**
 * Pool de Postgres. Mismo criterio TLS que tdp-gestion-app (la BD de producción
 * es la PostgreSQL gestionada de UpCloud con CA privada):
 *   1. sslmode=disable   → sin TLS.
 *   2. sslmode=no-verify → TLS sin verificar certificado (manda sobre la CA).
 *   3. DATABASE_CA_CERT  → verificación completa contra esa CA.
 *   4. otro sslmode      → verificación contra el almacén del sistema.
 */
function buildPoolConfig(): pg.PoolConfig {
  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n").trim() || undefined;
  const rawUrl = process.env.DATABASE_URL;
  let sslmode: string | null = null;
  let connectionString = rawUrl;
  if (rawUrl) {
    try {
      const u = new URL(rawUrl);
      sslmode = u.searchParams.get("sslmode");
      u.searchParams.delete("sslmode");
      connectionString = u.toString();
    } catch {
      return { connectionString: rawUrl, max: 10, ...(ca ? { ssl: { ca } } : {}) };
    }
  }
  let ssl: pg.PoolConfig["ssl"];
  if (sslmode === "disable") ssl = false;
  else if (sslmode === "no-verify") ssl = { rejectUnauthorized: false };
  else if (ca) ssl = { ca, rejectUnauthorized: true };
  else if (sslmode) ssl = { rejectUnauthorized: true };
  return { connectionString, max: 10, ...(ssl !== undefined ? { ssl } : {}) };
}

const pool = new pg.Pool(buildPoolConfig());

export const db = drizzle(pool, { schema });
export { schema };
