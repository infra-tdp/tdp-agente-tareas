#!/bin/sh
set -e

echo "[entrypoint] TDP Agente de tareas — aplicando migraciones y arrancando"
node scripts/migrate.mjs
exec node dist/index.js
