# syntax=docker/dockerfile:1
#
# Phase 16 (§9 of the build plan: "Deploy: Docker Compose local ->
# Fly.io hosted"). Multi-stage build using `turbo prune` to isolate
# just what @ai-world/web needs from the pnpm workspace, then Next's
# `output: 'standalone'` (apps/web/next.config.js) to keep the final
# runtime image to only the node_modules Next's build tracer actually
# needs — not the whole monorepo's installed dependencies.
#
# Build from the REPO ROOT, not this directory:
#   docker build -f apps/web/Dockerfile -t ai-world-web .

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable

# --- 1. Prune the workspace down to @ai-world/web's own dependency subgraph ---
FROM base AS pruner
WORKDIR /app
COPY . .
RUN npx turbo prune @ai-world/web --docker

# --- 2. Install (cached separately from source so a source-only change
#         doesn't invalidate the install layer) and build ---
FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
# `turbo prune` only pulls in files owned by a workspace package's own
# dependency graph — the root tsconfig.json every package's
# tsconfig.json `extends` (for esModuleInterop, target, etc.) isn't
# part of any single package, so it's dropped from out/full/ and has
# to be copied explicitly or every package's tsc build fails.
COPY --from=pruner /app/tsconfig.json ./tsconfig.json

# Every DB-touching ROUTE HANDLER is force-dynamic, so nothing queries
# the database during the build — but Next's "Collecting page data"
# step still IMPORTS every route module (in its own worker process) to
# inspect its exports, and apps/web/src/lib/auth.ts calls getDb() at
# module scope (NextAuth's adapter needs a db instance to construct,
# not just to query later). getDb() throws synchronously if
# DATABASE_URL is merely unset. Real secrets are injected at container
# start (Fly secrets / orchestrator env), never baked into the image —
# but a Docker `ENV` here is NOT enough: Next's page-data-collection
# workers don't reliably inherit it (empirically verified — the same
# failure persisted with ENV DATABASE_URL set). apps/web/next.config.js
# already loads a repo-root `.env` FILE via dotenv on every process
# that evaluates it, including each worker (that's the actual
# mechanism that makes local `pnpm build` work, since a real `.env`
# sits at the repo root there) — so write the same kind of file here,
# scoped to this stage's filesystem only, deleted before the runtime
# image is assembled a few lines down.
RUN printf 'DATABASE_URL=postgres://build:build@127.0.0.1:5432/build_time_placeholder\nAUTH_SECRET=build-time-placeholder-not-used-at-runtime\n' > .env

RUN npx turbo run build --filter=@ai-world/web
RUN rm -f .env

# --- 3. Minimal runtime image ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
# No apps/web/public directory exists yet — this app serves no static
# assets today. Add this COPY back the day one shows up (favicon,
# manifest, etc.), or it'll fail the same way this line failed until
# the fix that added this comment.

USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
