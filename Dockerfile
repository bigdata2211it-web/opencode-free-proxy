# syntax=docker/dockerfile:1
# ── Build stage ──────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app

# Reproducible install from lockfile (never floating npm install)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force

# ── Run stage ────────────────────────────────────────────────
FROM node:24-alpine AS run

# Minimal runtime env
ENV NODE_ENV=production \
    NODE_OPTIONS=--use-openssl-ca \
    PROXY_PORT=6446 \
    KEYS_FILE=/data/api-keys.json

WORKDIR /app

# Drop privileges on copy — no root-owned app tree, no chown RUN
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json models.json ./
COPY --chown=node:node src ./src

# Writable keys dir only (rootfs can be read-only at runtime)
RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 6446

# Liveness: process up + HTTP stack answering
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PROXY_PORT||6446)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# exec form — no shell, no signal loss
CMD ["node", "src/index.mjs"]
