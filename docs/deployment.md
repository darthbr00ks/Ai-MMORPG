# Deployment (Phase 16 — Alpha Deploy)

Per §9/§16 of the build plan: Docker Compose locally, Fly.io hosted.
`apps/simulation-worker` is a long-running tick loop — it structurally
cannot move to a serverless platform. `apps/web` could move to
Vercel later if wanted; there's no reason to split them for the alpha.

This doc is the deploy runbook. It assumes you already have a working
local dev environment (repo root README / `docs/architecture.md`'s
Phase 1 acceptance checklist) and the [`fly` CLI](https://fly.io/docs/flyctl/install/)
installed and authenticated (`fly auth login`).

## 1. Provision Postgres

Any reachable Postgres 16 works. Fly Postgres is the path of least
friction if everything else is on Fly:

```bash
fly postgres create --name ai-world-db --region iad --vm-size shared-cpu-1x --initial-cluster-size 1
```

Note the connection string it prints — you'll attach it to both apps
below, which also grants both machines network access to the Postgres
app on Fly's private network.

## 2. Redis — optional today

`packages/shared`'s env schema has a `REDIS_URL` with a default and
`apps/simulation-worker` depends on `bullmq`/`ioredis`, but **nothing
in the codebase actually connects to Redis yet** — the tick loop is a
plain `setTimeout` loop (see `apps/simulation-worker/src/index.ts`),
not a BullMQ queue. Those dependencies exist for the queue-based tick
scheduling `docs/architecture.md`'s stack table describes as the
long-term direction, not because anything requires it right now.

Skip provisioning Redis for the alpha unless/until something actually
uses it — `REDIS_URL`'s default (`redis://localhost:6379`) satisfies
the env schema even if nothing ever connects.

## 3. Create the two Fly apps

From the **repo root** (the Dockerfiles need the whole pnpm workspace
as build context — see the comments in `apps/web/Dockerfile` /
`apps/simulation-worker/Dockerfile` for why):

```bash
fly launch --config fly.web.toml --no-deploy
fly launch --config fly.worker.toml --no-deploy
```

`--no-deploy` just registers the app names/regions; `fly.web.toml` and
`fly.worker.toml` already have `[build]`/`[[vm]]` configured, so
`fly launch` shouldn't need to rewrite them. If it does, diff before
accepting — those files also carry inline comments about the
production env values (§12: `GAME_DAY_REAL_SECONDS=86400`,
`SIMULATION_TICK_SECONDS=1800`) that are easy to lose.

## 4. Attach Postgres and set secrets

```bash
fly postgres attach ai-world-db --app ai-world-web
fly postgres attach ai-world-db --app ai-world-worker
```

`fly postgres attach` sets `DATABASE_URL` as a secret automatically.
Set the rest by hand — **never commit these, and never put them in
the `fly.*.toml` files**, which are checked into git:

```bash
AUTH_SECRET=$(openssl rand -base64 32)

fly secrets set --config fly.web.toml \
  AUTH_SECRET="$AUTH_SECRET" \
  NEXTAUTH_URL="https://ai-world-web.fly.dev" \
  GOOGLE_CLIENT_ID="..." \
  GOOGLE_CLIENT_SECRET="..."

fly secrets set --config fly.worker.toml \
  AUTH_SECRET="$AUTH_SECRET"
```

`AUTH_SECRET` must be the **same value** on both apps — reuse the
generated value rather than running `openssl rand` twice. It's not
used by the worker's own logic, but `packages/shared`'s `loadConfig()`
validates it as required on every app that loads shared config (§17),
and a mismatched value between the two apps is a config bug waiting
to happen.

Only set `ANTHROPIC_API_KEY` (both apps) and flip `AI_USE_LIVE=true`
once you've confirmed the mocked path works end-to-end in production —
§19's whole point is that the mocked provider proves the loop before
spending a cent:

```bash
fly secrets set --config fly.web.toml ANTHROPIC_API_KEY="..." AI_USE_LIVE=true
fly secrets set --config fly.worker.toml ANTHROPIC_API_KEY="..." AI_USE_LIVE=true
```

## 5. Deploy

```bash
fly deploy --config fly.web.toml
fly deploy --config fly.worker.toml
```

## 6. Run migrations and seed against production

Migrations don't run automatically on deploy (there's no release
command configured — deliberately: a migration failure should block a
deploy loudly, not run unattended inside one). Run them through a Fly
proxy to the attached Postgres:

```bash
fly proxy 5433:5432 --app ai-world-db &
DATABASE_URL="postgres://<user>:<password>@localhost:5433/<db>" pnpm db:migrate
DATABASE_URL="postgres://<user>:<password>@localhost:5433/<db>" pnpm db:seed
kill %1   # stop the proxy
```

(`fly postgres attach`'s output includes the real user/password/db
name — reuse that connection string with the port swapped to 5433.)

## 7. Promote the first admin

No self-service admin promotion exists yet (§13, `docs/architecture.md`'s
Phase 15 section) — this is a one-time manual step:

```bash
DATABASE_URL="postgres://...@localhost:5433/..." psql "$DATABASE_URL" \
  -c "update users set role = 'admin' where email = 'you@example.com';"
```

(The user row only exists after that email has signed in once via
Google OAuth — sign in first, then promote.)

## 8. Smoke test

```bash
curl -sf https://ai-world-web.fly.dev/ > /dev/null && echo "web up"
fly logs --config fly.worker.toml | grep -m1 "tick-1 complete"
```

Then in the browser: sign in, claim a seeded character, submit a
directive, watch `/spectate` for the resulting event within one tick
interval (1800s in prod — patient, this isn't dev's 10s cadence).
Check `/admin` (after promoting yourself, step 7) for AI cost, and
`/admin/characters/<id>` to confirm decisions are actually being
recorded.

## Rollback

```bash
fly releases --config fly.web.toml
fly deploy --config fly.web.toml --image <previous-release-image>
```

Same pattern for `fly.worker.toml`. The worker has no state of its own
outside Postgres, so rolling it back is safe at any point; rolling
back `apps/web` mid-request is also safe (Next's standalone server has
no in-memory session state — sessions live in the `sessions` table via
the database session strategy).

## What's still manual / not automated here

- CI/CD (auto-deploy on merge to `main`) — not configured. Every
  deploy above is a manual `fly deploy`.
- Database backups — Fly Postgres takes its own snapshots; verify the
  retention window matches your actual risk tolerance before relying
  on it.
- Horizontal scaling `apps/web` beyond `min_machines_running = 1` — no
  reason to before there's real traffic; `apps/simulation-worker` must
  never run more than one instance (nothing makes concurrent tick
  loops against the same world safe — see `packages/database/src/simulation-control.ts`'s
  doc comment on `claimPendingManualTick`, which is only atomic-safe
  because there's one worker process today).
