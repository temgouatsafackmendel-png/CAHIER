# ==============================================================================
# Dockerfile Multi-Stage — Cahier (Application de Notes SQLite FTS5)
# ==============================================================================

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run lint && npm test && npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV SQLITE_DB_PATH=/app/data/notes.sqlite

# Création d'un utilisateur non-root (Principe du moindre privilège)
RUN addgroup -S cahier && adduser -S cahier -G cahier \
    && mkdir -p /app/data && chown -R cahier:cahier /app

COPY --from=builder --chown=cahier:cahier /app/package.json ./package.json
COPY --from=builder --chown=cahier:cahier /app/node_modules ./node_modules
COPY --from=builder --chown=cahier:cahier /app/dist ./dist
COPY --from=builder --chown=cahier:cahier /app/server.ts ./server.ts
COPY --from=builder --chown=cahier:cahier /app/cli.ts ./cli.ts
COPY --from=builder --chown=cahier:cahier /app/src ./src
COPY --from=builder --chown=cahier:cahier /app/migrations ./migrations

USER cahier
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["npx", "tsx", "server.ts"]
