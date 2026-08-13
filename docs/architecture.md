# AI World Architecture

## Phase 1 Vertical Slice

See the main problem statement for full architectural decisions. This doc captures implementation notes.

## Package Structure

- `packages/shared` — Config (Zod-validated), game-time utilities, action registry, shared types
- `packages/database` — Drizzle schema, migrations, seed (20 chars, 10 locations)
- `packages/game-engine` — Movement validator, wallet atomicity, action validator, directive validator
- `packages/ai` — AgentModelProvider interface, MockProvider (default), AnthropicProvider (gated)
- `apps/simulation-worker` — Tick loop, AI pipeline, event resolution
- `apps/web` — Next.js 14, character pages, directive form, SSE feed

## Security Boundary

`packages/game-engine` NEVER imports `packages/ai`.
`packages/ai` NEVER imports `packages/game-engine` or `packages/database`.
Only `apps/simulation-worker` calls both, and only after validation does anything get written.
