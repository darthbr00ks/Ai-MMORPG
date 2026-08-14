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

## Known issue — jsonb double-encoding (drizzle-orm 0.31.x + postgres.js)

Every `jsonb` column is currently stored double-JSON-encoded — confirmed via `jsonb_typeof()` returning `'string'` instead of `'object'`/`'array'` on every jsonb column, including seed data. Root cause: `drizzle-orm`'s `PgJsonb.mapToDriverValue` unconditionally `JSON.stringify`s before the value reaches `postgres.js`, which serializes it again; `mapFromDriverValue` defensively re-parses on the way out, which is why every read that goes through Drizzle (100% of this app's code today) is unaffected. Anything that reads the column with **raw SQL** (`psql`, an external BI tool, a future admin-console query) will get a JSON string instead of an object. Pre-existing since Phase 1 seed data — not introduced by Phase 10. Needs a dedicated fix (dependency version pairing + a data-migration pass for already-corrupted rows), tracked separately rather than folded into feature work.
