# syntax=docker/dockerfile:1
#
# Phase 16 (§9 of the build plan: "the worker is long-running;
# serverless can't host it" — this always needs a real, always-on
# container, unlike apps/web which could in principle move to Vercel
# later). Same turbo-prune pattern as apps/web/Dockerfile; see that
# file's comments for the tsbuildinfo/.dockerignore gotcha this also
# depends on.
#
# Unlike apps/web, tsc --build never executes application code (it
# only type-checks and transpiles), and this app's own DB/Redis access
# happens inside main(), which only runs when the built output is
# actually started — so no build-time env placeholder is needed here.
#
# Build from the REPO ROOT, not this directory:
#   docker build -f apps/simulation-worker/Dockerfile -t ai-world-worker .

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable

# --- 1. Prune the workspace down to @ai-world/simulation-worker's own dependency subgraph ---
FROM base AS pruner
WORKDIR /app
COPY . .
RUN npx turbo prune @ai-world/simulation-worker --docker

# --- 2. Install + build ---
FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
COPY --from=pruner /app/tsconfig.json ./tsconfig.json
RUN npx turbo run build --filter=@ai-world/simulation-worker

# --- 3. Runtime image ---
# No Next-style "standalone" bundling exists for a plain tsc build, so
# (unlike apps/web) this copies the builder stage's full node_modules
# + dist output rather than a pruned runtime-only subset. Correct and
# simple; revisit only if image size becomes an actual operational
# problem, not preemptively.
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 worker
COPY --from=builder --chown=worker:nodejs /app .
USER worker
CMD ["node", "apps/simulation-worker/dist/index.js"]
