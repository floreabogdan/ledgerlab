# syntax=docker/dockerfile:1

FROM node:25-alpine AS dependencies
WORKDIR /app
RUN apk add --no-cache g++ make python3
COPY package.json package-lock.json ./
RUN npm ci

FROM node:25-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=:memory:
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:25-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATABASE_URL=/app/data/ledgerlab.db \
    ATTACHMENTS_DIR=/app/data/attachments \
    REGISTRATION_MODE=first-user

LABEL org.opencontainers.image.title="LedgerLab" \
      org.opencontainers.image.description="A self-hosted personal finance workspace" \
      org.opencontainers.image.source="https://github.com/floreabogdan/ledgerlab" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

RUN mkdir -p /app/data \
    && chown node:node /app/data \
    && chmod 0700 /app/data \
    && rm -rf /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder --chmod=0444 /app/LICENSE /app/NOTICE ./

USER node
EXPOSE 3000
VOLUME ["/app/data"]
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "server.js"]
