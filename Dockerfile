# syntax=docker/dockerfile:1
# Multi-stage build for the two runtimes of this repo (E1.2):
#   target "web"    -> Next.js standalone server
#   target "worker" -> plain Node process consuming BullMQ jobs
#
# Why the worker runs through tsx instead of a compiled bundle: the repo has no
# emit pipeline (tsconfig is noEmit; Next only compiles app/). Adding tsup/esbuild
# means a new dependency, which needs approval. tsx is already a devDependency and
# the worker is a long-lived process, so the one-off transpile cost is irrelevant.
# Revisit when a build step exists.

# --- base: pnpm on Node 22 ---------------------------------------------------
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# --- deps: full install (dev deps needed by next build and by tsx) -----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- build: Next.js standalone output ---------------------------------------
FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build && test -f .next/standalone/server.js

# --- web: runtime for the Next.js server ------------------------------------
FROM node:22-alpine AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN apk add --no-cache curl
WORKDIR /app
# `node` (uid 1000) ships with the image — run unprivileged.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]

# --- migrate: one-shot schema migration (and seed) --------------------------
# Separate from "worker" because it needs drizzle-kit (a devDependency), the
# drizzle.config.ts and the checked-in ./drizzle SQL — none of which belong in a
# long-lived runtime image. Shares the same deps layer, so it costs no rebuild.
FROM base AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json drizzle.config.ts ./
COPY --chown=node:node drizzle ./drizzle
# src is needed twice: drizzle.config.ts points at the schema barrel, and
# `pnpm db:seed` (tsx) runs from this same image.
COPY --chown=node:node src ./src
USER node
CMD ["pnpm", "db:migrate"]

# --- worker: BullMQ consumer -------------------------------------------------
FROM base AS worker
ENV NODE_ENV=production \
    WORKER_HEARTBEAT_FILE=/tmp/mysp-worker-heartbeat
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node src ./src
USER node
# Liveness without an HTTP port: the worker refreshes a heartbeat file every
# WORKER_HEARTBEAT_INTERVAL_MS (default 15s). A blocked event loop stops it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const fs=require('node:fs');const p=process.env.WORKER_HEARTBEAT_FILE||'/tmp/mysp-worker-heartbeat';const age=Date.now()-fs.statSync(p).mtimeMs;if(age>60000){console.error('heartbeat stale '+age+'ms');process.exit(1);}"
# `node --import tsx` runs the loader IN-PROCESS: the worker is PID 1 and gets
# SIGTERM directly (the tsx CLI would fork a child and swallow the signal).
CMD ["node", "--import", "tsx", "src/worker/index.ts"]
