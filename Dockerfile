FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Production image ──────────────────────────────────────────
FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/web/views ./src/web/views
COPY --from=builder /app/src/web/public ./src/web/public
COPY --from=builder /app/src/db/migrations ./src/db/migrations

# Local receipt uploads directory (unused in prod with S3, but harmless)
RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "dist/server.js"]

