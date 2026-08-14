# AI World Architecture

## Phase 1 Vertical Slice

See the main problem statement for full architectural decisions. This doc captures implementation notes.

## Package Structure

- `packages/shared` — Config (Zod-validated), game-time utilities, action registry, shared types
- `packages/database` — Drizzle schema, migrations, seed (20 chars, 10 locations)
- `packages/game-engine` — Movement validator, wallet atomicity, relationship engine, action validator, directive validator
- `packages/ai` — AgentModelProvider interface, MockProvider (default), AnthropicProvider (gated)
- `apps/simulation-worker` — Tick loop, AI pipeline, event resolution, conversation orchestration
- `apps/web` — Next.js 14, character pages, directive form, SSE feed

## Security Boundary

`packages/game-engine` NEVER imports `packages/ai`.
`packages/ai` NEVER imports `packages/game-engine` or `packages/database`.
Only `apps/simulation-worker` calls both, and only after validation does anything get written.

## Phase 10 — Relationships & Conversations

- `packages/game-engine/src/relationship-engine.ts` is the only code path allowed to write the `relationships` table. Effects are a closed, deltas-only registry (`RELATIONSHIP_EFFECTS`) — the LLM never assigns a trust/affection/etc. value directly, only proposes an action (e.g. `START_CONVERSATION`) that, once validated, triggers a fixed-size engine effect. Every pair is canonicalized (`canonicalizeCharacterPair`) to one row regardless of call order.
- `START_CONVERSATION` / `CONTINUE_CONVERSATION` are validated against per-character visibility (`charactersAtSameLocation`) and open-conversation ownership (`activeConversationIds`), both computed once per tick in `tick-processor.ts` from a batch load (not per-character queries) — see the "Conversation visibility & context" block there.
- A conversation is capped at `MAX_CONVERSATION_MESSAGES` (6) total messages, after which the engine ends it deterministically. Visibility/active-conversation state is a snapshot taken at the start of each tick, so a conversation's target only sees it from their next tick onward — the same single-tick lag MOVE/travel already has.

## Phase 11 — Layered Memory

- `apps/simulation-worker/src/memory-extraction.ts` runs once per COMPLETED game day (hooked to the day-rollover branch in `tick-processor.ts`), never once per tick — §5/§8's "periodic long-term summary, scheduled job, not per-decision cost." A character with zero events that day costs nothing.
- The day's real-time window is computed arithmetically (`gameDayRealTimeWindow` in `packages/shared/src/game-time.ts`) from the world epoch, NOT read off a `game_cycles` row — that row is only created lazily by whichever tick happens to observe a new day number, so a lookup-based window can silently and permanently skip a day that completed without a tick landing in it (this actually happened during development — see git history).
- `AgentDecisionContext.recentMemories` is populated from a per-tick batch load of each character's 5 most recent memories (one query for the whole world, grouped client-side).

## Phase 12 — Economy Depth

- Ships a simple fixed-price NPC market (§6), not player-to-player price discovery: `items.basePriceCents` is what `BUY_ITEM` pays; `SELL_ITEM` pays `basePriceCents * MARKET_SELL_MULTIPLIER` (0.5) — buying and immediately reselling is always a loss, ordinary shop economics.
- `BUY_ITEM`/`SELL_ITEM` are validated to the `market` location by slug (`MARKET_LOCATION_SLUG` in `action-validator.ts`) — hardcoded, matching how the world currently has exactly one market. `GIVE_ITEM`/`TRANSFER_MONEY` instead require the target character to be visible at the same location (reusing the Phase 10 visibility batch-load).
- `packages/game-engine/src/inventory.ts` (`addToInventory`/`removeFromInventory`/`transferItem`) and `wallet.ts`'s new `debitWallet` (the mirror of `creditWallet`, for money leaving the game entirely — an NPC purchase, not a character-to-character transfer) follow the same atomicity rule as `transferMoney`: validate BOTH sides of a transfer before writing EITHER — never mutate one side, then discover the other side can't proceed.
- `GIVE_ITEM`/`TRANSFER_MONEY` are gifts (§5) and trigger a deterministic relationship effect (`ITEM_GIVEN` / `MONEY_GIVEN` in `relationship-engine.ts`) — same closed, deltas-only registry as Phase 10's conversation effects, extended deliberately rather than left for the LLM to decide.

## Phase 13 — Daily Player Report

- `apps/simulation-worker/src/daily-report.ts` runs on the same once-per-completed-game-day hook as Phase 11's memory extraction (same `gameDayRealTimeWindow`-derived window, same "don't backfill a multi-day outage" limitation) — a report is generated from that day's actual `game_events` only (§16: "never fabricated"), via `provider.summarizeEvents` (routed to the strong/dialogue model, §8). Idempotent: a character+day that already has a report is skipped, not duplicated.
- `describeGameEvent` (moved to `packages/shared/src/event-description.ts`) is shared between memory extraction and the daily report — one place turns a raw event into the prose the model sees, so the two features can't drift apart on what a given event type means.
- Surfaced on the character detail page (`apps/web/src/app/characters/[id]/page.tsx`) — last 5 reports, newest game day first.

## Phase 14 — Spectator Broadcast View

- `apps/web/src/app/api/events/stream/route.ts` now resolves `actorCharacterId`/`targetCharacterId`/`locationId` into names, and pre-computes a human sentence (`describeGameEvent`, from `packages/shared`) server-side, before the SSE payload goes out. Found and fixed while building this: `EventFeed`'s `actorName` field had been silently `undefined` since it was written — the route never actually sent it, only the raw id.
- Display formatting is computed **server-side** deliberately, not in the `'use client'` broadcast page — `@ai-world/shared`'s barrel re-exports `load-env.ts` (Node-only `fs`/`dotenv`), so importing the shared package from client code risks pulling that into the browser bundle. The route already runs server-side and already depends on `@ai-world/shared`, so it's the natural place; the client only ever renders pre-formatted strings.
- `/spectate/broadcast` (`apps/web/src/app/spectate/broadcast/page.tsx`) is a full-viewport (`fixed inset-0 z-50`), auto-rotating single-scene view meant for an OBS browser source — connects to the same SSE stream, filters to `importance >= 0.15` (routine noise isn't broadcast-worthy), rotates every 6s through up to 12 recent scenes, and cuts immediately to a fresh sufficiently-important event rather than waiting its turn. It still renders inside the root layout's nav (Next.js App Router composes layouts; there's no per-route opt-out without a multi-root-layout restructure), so the nav bar exists in the DOM underneath it — acceptable for now since the fixed overlay covers it visually, but worth a proper route-group split if this becomes a real OBS dependency.

## Phase 15 — Admin/Debug Console

- `/admin` (gated to `users.role === 'admin'` via `apps/web/src/lib/admin.ts`) answers "why did this character do that" in two clicks: Admin nav link → character. `role` is not part of the NextAuth session object (database session strategy only carries id/name/email/image), so every gate queries `users` by id rather than trusting anything session-cached.
- `/admin/characters/[id]` is the actual answer: `agent_decisions` left-joined to `agent_actions` (intent/goal + valid/rejected/fallback verdict together), a separate "Recent Rejected Actions" pull from `game_events` (there's no FK tying an action to its ACTION_REJECTED event — payload shapes differ, so they're queried and shown separately, not force-joined), per-character AI cost, relationships, and recent memories.
- Simulation Test Mode (Pause/Resume/Run 1 Tick/Run 1 Day/speed multipliers): `packages/database/src/simulation-control.ts` — a single singleton row (`id = 'default'`) the worker's tick loop polls once per iteration and the admin console reads/writes. No queue infrastructure: `claimPendingManualTick` atomically decrements-and-checks in one `UPDATE ... WHERE pendingManualTicks > 0`, which is what keeps "Run 1 Day" (queues N ticks) safe even though today there's only ever one worker process. While paused, the worker polls every 2s instead of the configured tick interval, so admin actions feel responsive rather than waiting out whatever interval was in effect when Pause was pressed.
- No self-service admin promotion exists yet — the first admin is `UPDATE users SET role = 'admin' WHERE email = '...'` by hand. Verified end-to-end against a real NextAuth database session (seeded `users`/`sessions` rows, not a mocked `auth()`) during development: unauthenticated → 307 to `/auth/signin`, signed-in non-admin → 307 to `/`, admin → 200.
- **Test infrastructure fix, found while verifying this live:** `pnpm test` (all packages via one `turbo run test`) was flaking due to cross-*package* Postgres contention — `apps/web`'s and `apps/simulation-worker`'s integration tests, run as separate OS processes by turbo's normal parallelism, hit the same real `DATABASE_URL` concurrently. Per-package `fileParallelism: false` (added for Phase 12's within-package version of this) wasn't enough. Fixed at the root: `"test": "turbo run test --concurrency=1"` in the root `package.json`. Verified: 3/3 clean full-suite runs after the fix, reproduced the failure without it.

## Phase 16 — Alpha Deploy Prep

- `apps/web/Dockerfile` and `apps/simulation-worker/Dockerfile`: multi-stage builds using `turbo prune --docker` to isolate each app's own dependency subgraph, built from the **repo root** (not the app directory — the pnpm workspace needs the full context). `apps/web` additionally uses Next's `output: 'standalone'` (`apps/web/next.config.js`) to keep the runtime image to only the node_modules Next's build tracer determined are actually needed.
- `fly.web.toml` / `fly.worker.toml` (repo root): Fly.io app configs. The worker has no `[http_service]` — it serves no traffic, it's a tick loop — and both pin `GAME_DAY_REAL_SECONDS=86400`/`SIMULATION_TICK_SECONDS=1800` (§12's production values; dev's `.env.example` values are 300/10 and exist to make a "day" watchable in minutes).
- `docs/deployment.md`: the actual runbook — Postgres provisioning, secrets, deploy order, running migrations against production, promoting the first admin, smoke test, rollback. Notes that Redis is provisioned-for-later but not load-bearing today (the tick loop is a plain `setTimeout` loop, not a BullMQ queue, despite those being dependencies).
- **Three real bugs found and fixed by actually running `docker build`/`docker run` rather than treating this as paperwork:**
  1. `packages/*/tsconfig.json` all `extends: "../../tsconfig.json"` — a root-level file `turbo prune`'s pruned output doesn't include (it isn't owned by any single workspace package). Every package's `tsc --build` failed until the Dockerfiles copy it in explicitly.
  2. **`.dockerignore`'s bare `*.tsbuildinfo` pattern only matches at the build-context ROOT, not recursively** (unlike `.gitignore`, Docker's ignore matching needs an explicit `**/` prefix to recurse) — so a locally-generated `packages/database/tsconfig.tsbuildinfo` leaked into the image, and `tsc --build`'s incremental-build check saw a `.tsbuildinfo` newer than the sources and silently emitted nothing, believing a fresh checkout was already compiled. Every pattern in `.dockerignore` now has a `**/` prefix.
  3. `apps/web/src/lib/auth.ts` calls `getDb()` at **module scope** (NextAuth's adapter needs a db instance to construct). Next's "Collecting page data" build step imports every route module — including in worker processes that don't reliably inherit a Docker `ENV`-set `DATABASE_URL` (empirically verified: setting it via `ENV` did not fix the failure; the actual working fix was writing a real `.env` **file**, matching the exact mechanism `apps/web/next.config.js` already uses for local dev, which every worker process re-reads on its own). Fixed by writing that placeholder file in the Docker build stage only, deleted before the runtime image is assembled — never a real secret, never present in the deployed image.
- Also found (and fixed as data hygiene, not a code bug) while running the containerized worker against the shared dev database: an earlier manual cleanup of orphaned test characters had deleted the `characters` rows without ending their open `conversations` — `conversations.participant_ids` is a jsonb array with no FK enforcement, so the dangling reference survived silently until a real seeded character's next `CONTINUE_CONVERSATION` tried to write a `game_events` row with a `target_character_id` that no longer existed. A reminder of exactly why the jsonb double-encoding issue above matters operationally: `jsonb_array_elements_text` on the raw column fails outright (`cannot extract elements from a scalar`) until you know to unwrap it with `(col #>> '{}')::jsonb` first.

## Known issue — jsonb double-encoding (drizzle-orm 0.31.x + postgres.js)

Every `jsonb` column is currently stored double-JSON-encoded — confirmed via `jsonb_typeof()` returning `'string'` instead of `'object'`/`'array'` on every jsonb column, including seed data. Root cause: `drizzle-orm`'s `PgJsonb.mapToDriverValue` unconditionally `JSON.stringify`s before the value reaches `postgres.js`, which serializes it again; `mapFromDriverValue` defensively re-parses on the way out, which is why every read that goes through Drizzle (100% of this app's code today) is unaffected. Anything that reads the column with **raw SQL** (`psql`, an external BI tool, a future admin-console query) will get a JSON string instead of an object. Pre-existing since Phase 1 seed data — not introduced by Phase 10. Needs a dedicated fix (dependency version pairing + a data-migration pass for already-corrupted rows), tracked separately rather than folded into feature work.
