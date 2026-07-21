#!/usr/bin/env node
/**
 * Aplica las migraciones de ./drizzle al arrancar el contenedor (mismo patrón
 * que tdp-gestion-app). TLS resuelto igual que src/db/index.ts.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

function buildPoolConfig() {
  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n").trim() || undefined;
  const rawUrl = process.env.DATABASE_URL;
  let sslmode = null;
  let connectionString = rawUrl;
  if (rawUrl) {
    try {
      const u = new URL(rawUrl);
      sslmode = u.searchParams.get("sslmode");
      u.searchParams.delete("sslmode");
      connectionString = u.toString();
    } catch {
      return { connectionString: rawUrl, max: 1, ...(ca ? { ssl: { ca } } : {}) };
    }
  }
  let ssl;
  if (sslmode === "disable") ssl = false;
  else if (sslmode === "no-verify") ssl = { rejectUnauthorized: false };
  else if (ca) ssl = { ca, rejectUnauthorized: true };
  else if (sslmode) ssl = { rejectUnauthorized: true };
  return { connectionString, max: 1, ...(ssl !== undefined ? { ssl } : {}) };
}

const pool = new pg.Pool(buildPoolConfig());
const db = drizzle(pool);

try {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("[migrate] Migraciones aplicadas");
} finally {
  await pool.end();
}
