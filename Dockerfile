# =============================================================================
#  TDP Agente de tareas — imagen construida POR COOLIFY en cada push (mismo
#  patrón que tdp-gestion-app). Multi-stage: deps → build TS → runtime mínimo
#  con ffmpeg (extracción de audio/fotogramas de los vídeos de WhatsApp).
# =============================================================================

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3100 \
    DATA_DIR=/data

RUN apk add --no-cache ffmpeg wget \
    && addgroup -S tdp && adduser -S tdp -G tdp \
    && mkdir -p /data && chown tdp:tdp /data

COPY --from=deps --chown=tdp:tdp /app/node_modules ./node_modules
COPY --from=build --chown=tdp:tdp /app/dist ./dist
COPY --from=build --chown=tdp:tdp /app/drizzle ./drizzle
COPY --from=build --chown=tdp:tdp /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=build --chown=tdp:tdp /app/package.json ./package.json
COPY --chown=tdp:tdp docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh \
    && npm prune --omit=dev --no-audit --no-fund

USER tdp
EXPOSE 3100
VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3100/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
