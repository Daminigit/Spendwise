# ── Build ─────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────
FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
# Read at runtime relative to the working directory
COPY --from=builder /app/src/web/views ./src/web/views
COPY --from=builder /app/src/web/public ./src/web/public
COPY --from=builder /app/src/db/migrations ./src/db/migrations

# Local receipt storage when S3_* is not configured
RUN mkdir -p uploads && chown node:node uploads
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply migrations (and seed the demo when SEED_DEMO=true), then serve
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/server.js"]
