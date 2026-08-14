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

## Known issue — jsonb double-encoding (drizzle-orm 0.31.x + postgres.js)

Every `jsonb` column is currently stored double-JSON-encoded — confirmed via `jsonb_typeof()` returning `'string'` instead of `'object'`/`'array'` on every jsonb column, including seed data. Root cause: `drizzle-orm`'s `PgJsonb.mapToDriverValue` unconditionally `JSON.stringify`s before the value reaches `postgres.js`, which serializes it again; `mapFromDriverValue` defensively re-parses on the way out, which is why every read that goes through Drizzle (100% of this app's code today) is unaffected. Anything that reads the column with **raw SQL** (`psql`, an external BI tool, a future admin-console query) will get a JSON string instead of an object. Pre-existing since Phase 1 seed data — not introduced by Phase 10. Needs a dedicated fix (dependency version pairing + a data-migration pass for already-corrupted rows), tracked separately rather than folded into feature work.
