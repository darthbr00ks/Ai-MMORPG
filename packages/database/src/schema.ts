import {
  pgTable,
  text,
  integer,
  real,
  timestamp,
  boolean,
  pgEnum,
  primaryKey,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
// Not drizzle-orm's built-in `jsonb` — see custom-jsonb.ts for why.
// Deliberately WITHOUT the `.js` extension every other relative
// import in this package uses: drizzle-kit's own schema loader (a
// separate esbuild/CJS pipeline from this package's own `tsc`) fails
// to resolve a `.js`-suffixed relative import here specifically —
// `pnpm db:generate` throws MODULE_NOT_FOUND with it, works without
// it. tsc under this package's own CommonJS/Node moduleResolution
// (packages/database/tsconfig.json) is fine either way — confirmed by
// building and by `db:generate` reporting a clean "no schema changes"
// diff after this file switched from drizzle-orm's jsonb() to this.
import { jsonbColumn as jsonb } from './custom-jsonb';

// Enums
export const characterStatusEnum = pgEnum('character_status', [
  'idle',
  'working',
  'traveling',
  'conversing',
  'sleeping',
  'planning',
]);

export const factionRankEnum = pgEnum('faction_rank', [
  'leader',
  'commander',
  'captain',
  'lieutenant',
  'member',
]);

export const moderationOutcomeEnum = pgEnum('moderation_outcome', [
  'accepted',
  'rejected',
  'flagged',
]);

export const validationResultEnum = pgEnum('validation_result', [
  'valid',
  'rejected',
  'fallback',
]);

export const memoryKindEnum = pgEnum('memory_kind', [
  'episodic',
  'relationship',
  'strategic',
]);

export const conversationVisibilityEnum = pgEnum('conversation_visibility', [
  'public',
  'private',
]);

// Users
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  emailVerified: timestamp('email_verified'),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  role: text('role').default('player').notNull(),
});

// Auth.js sessions & accounts
export const accounts = pgTable(
  'accounts',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.providerAccountId] }),
  })
);

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires').notNull(),
});

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.identifier, t.token] }),
  })
);

// Locations
export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description').notNull(),
  connections: jsonb('connections').notNull().default('[]'), // array of location slugs
});

// Characters
export const characters = pgTable('characters', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  age: integer('age').notNull(),
  appearanceJson: jsonb('appearance_json').default('{}'),
  background: text('background').notNull(),
  personalityTraits: jsonb('personality_traits').notNull().default('[]'),
  skills: jsonb('skills').notNull().default('[]'),
  ambitions: jsonb('ambitions').notNull().default('[]'),
  archetype: text('archetype').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Character ownership (separate from character identity)
export const characterOwnership = pgTable('character_ownership', {
  id: uuid('id').primaryKey().defaultRandom(),
  characterId: uuid('character_id')
    .notNull()
    .references(() => characters.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  acquiredAt: timestamp('acquired_at').defaultNow().notNull(),
  active: boolean('active').notNull().default(true),
});

// Character state (physical)
export const characterState = pgTable('character_state', {
  characterId: uuid('character_id')
    .primaryKey()
    .references(() => characters.id),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id),
  health: integer('health').notNull().default(100),
  fatigue: integer('fatigue').notNull().default(0),
  // 0 = well-fed, 100 = starving. Rises via the daily metabolism pass
  // (apps/simulation-worker/src/metabolism.ts), falls when held food
  // inventory is auto-consumed — see that module for the full model.
  hunger: integer('hunger').notNull().default(0),
  status: characterStatusEnum('status').notNull().default('idle'),
  travelEta: timestamp('travel_eta'),
  travelDestinationId: uuid('travel_destination_id').references(
    () => locations.id
  ),
  // Faction membership — nullable (no faction = no row in factions table).
  // Stored on characterState rather than characters to avoid the circular
  // FK that would arise from characters.factionId → factions and
  // factions.leaderId → characters (both declared in the same schema file).
  factionId: uuid('faction_id').references(() => factions.id),
  factionRank: factionRankEnum('faction_rank'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Wallets
export const wallets = pgTable('wallets', {
  characterId: uuid('character_id')
    .primaryKey()
    .references(() => characters.id),
  balanceCents: integer('balance_cents').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Transactions (append-only ledger)
export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  fromCharacterId: uuid('from_character_id').references(() => characters.id),
  toCharacterId: uuid('to_character_id').references(() => characters.id),
  amountCents: integer('amount_cents').notNull(),
  reason: text('reason').notNull(),
  // Free-text `reason` already existed for a human-readable audit trail;
  // `type` is the queryable categorization on top of it (e.g. "total
  // ever paid in wages" without parsing reason strings). Nullable, not
  // backfilled — plain text rather than a pg enum, matching how this
  // schema already treats open-ended taxonomies (items.category,
  // game_events.type) versus the one genuinely closed set
  // (character_status_enum). See TransactionType in @ai-world/shared
  // for the known values game-engine/wallet.ts actually writes.
  type: text('type'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Items
export const items = pgTable('items', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  // Fixed NPC-market price (§6: currency, food, iron, wood). Phase 12
  // ships a simple fixed-price market, not player-to-player price
  // discovery — BUY_ITEM pays this; SELL_ITEM pays a fraction of it
  // (see MARKET_SELL_MULTIPLIER in tick-processor.ts), so buying and
  // reselling immediately is always a loss, same as any NPC shop.
  // The `.default(0)` is a migration-safety placeholder, never a real
  // price — this column was added via ALTER TABLE (migration 0003) to
  // an already-existing `items` table; a NOT NULL column with no
  // default fails outright on any deploy path where `items` rows
  // already exist by the time that migration runs (this repo's own
  // migrate-then-seed order never hits that, but a migration should
  // not depend on deploy ordering it doesn't enforce). seed.ts always
  // sets a real value on insert; nothing reads this default in
  // practice.
  basePriceCents: integer('base_price_cents').notNull().default(0),
});

// Inventory
export const inventory = pgTable(
  'inventory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    quantity: integer('quantity').notNull().default(0),
  },
  (t) => ({
    // packages/game-engine/src/inventory.ts's addToInventory/
    // transferItem rely on this to make their upsert
    // (SELECT ... FOR UPDATE, then INSERT-or-UPDATE) actually safe —
    // without it, a SELECT FOR UPDATE against a character+item pair
    // with no existing row locks nothing, so two concurrent
    // first-time additions of the same item can both observe "no
    // row" and both INSERT, producing two rows for the same pair.
    characterItemUnique: unique('inventory_character_id_item_id_unique').on(t.characterId, t.itemId),
  })
);

// Directives
export const directives = pgTable('directives', {
  id: uuid('id').primaryKey().defaultRandom(),
  characterId: uuid('character_id')
    .notNull()
    .references(() => characters.id),
  userId: uuid('user_id').references(() => users.id),
  text: text('text').notNull(),
  submittedAt: timestamp('submitted_at').defaultNow().notNull(),
  gameDay: integer('game_day').notNull(),
  active: boolean('active').notNull().default(true),
});

// Game cycles
export const gameCycles = pgTable('game_cycles', {
  id: uuid('id').primaryKey().defaultRandom(),
  dayNumber: integer('day_number').notNull(),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  endedAt: timestamp('ended_at'),
});

// Phase 15: Simulation Test Mode (§13) — a single row the worker
// polls each iteration and the admin console reads/writes. Not a
// queue/event system; the worker already owns its own setTimeout
// loop, this just tells it whether to run this iteration and how many
// manually-queued ticks are owed. `id` is always the literal string
// 'default' — there is exactly one simulation, so exactly one row.
export const simulationControl = pgTable('simulation_control', {
  id: text('id').primaryKey().default('default'),
  paused: boolean('paused').notNull().default(false),
  speedMultiplier: real('speed_multiplier').notNull().default(1),
  pendingManualTicks: integer('pending_manual_ticks').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Agent decisions
export const agentDecisions = pgTable('agent_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  characterId: uuid('character_id')
    .notNull()
    .references(() => characters.id),
  gameCycleId: uuid('game_cycle_id')
    .notNull()
    .references(() => gameCycles.id),
  contextSummary: jsonb('context_summary').notNull().default('{}'),
  model: text('model').notNull(),
  chosenAction: text('chosen_action').notNull(),
  targetId: text('target_id'),
  latencyMs: integer('latency_ms'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Agent actions
export const agentActions = pgTable('agent_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  decisionId: uuid('decision_id')
    .notNull()
    .references(() => agentDecisions.id),
  actionType: text('action_type').notNull(),
  payload: jsonb('payload').notNull().default('{}'),
  validationResult: validationResultEnum('validation_result')
    .notNull()
    .default('valid'),
  executedAt: timestamp('executed_at').defaultNow().notNull(),
});

// Game events
export const gameEvents = pgTable('game_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  actorCharacterId: uuid('actor_character_id').references(() => characters.id),
  targetCharacterId: uuid('target_character_id').references(
    () => characters.id
  ),
  locationId: uuid('location_id').references(() => locations.id),
  payload: jsonb('payload').notNull().default('{}'),
  importance: real('importance').notNull().default(0.1),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Phase 10+ tables (shape fixed now)
export const relationships = pgTable('relationships', {
  id: uuid('id').primaryKey().defaultRandom(),
  characterAId: uuid('character_a_id')
    .notNull()
    .references(() => characters.id),
  characterBId: uuid('character_b_id')
    .notNull()
    .references(() => characters.id),
  trust: integer('trust').notNull().default(0),
  respect: integer('respect').notNull().default(0),
  affection: integer('affection').notNull().default(0),
  fear: integer('fear').notNull().default(0),
  hostility: integer('hostility').notNull().default(0),
  familiarity: integer('familiarity').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Factions — alliances of characters who have chosen to act together.
// FK to characters is one-way (leaderId → characters) to avoid a circular
// dependency with characterState.factionId → factions. leaderId is nullable
// at insert time because the faction row must exist before its members'
// characterState rows can reference it; it is always set immediately after
// the founding INSERT in tick-processor.ts.
export const factions = pgTable('factions', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  icon: text('icon').notNull().default('shield'),
  foundedGameDay: integer('founded_game_day').notNull().default(0),
  leaderId: uuid('leader_id').references(() => characters.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  locationId: uuid('location_id').references(() => locations.id),
  // Character IDs taking part (pairwise for Phase 10; jsonb array leaves
  // room for group conversations later without a schema change). This is
  // how a tick knows "does character X have an open conversation to
  // continue" — conversation_messages alone can't answer that, since a
  // character can be a conversation's target before they've sent a
  // message of their own.
  participantIds: jsonb('participant_ids').notNull().default('[]'),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  endedAt: timestamp('ended_at'),
  visibility: conversationVisibilityEnum('visibility')
    .notNull()
    .default('public'),
});

export const conversationMessages = pgTable('conversation_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id),
  characterId: uuid('character_id')
    .notNull()
    .references(() => characters.id),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const memories = pgTable('memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  characterId: uuid('character_id')
    .notNull()
    .references(() => characters.id),
  kind: memoryKindEnum('kind').notNull(),
  content: text('content').notNull(),
  importance: real('importance').notNull().default(0.5),
  sourceEventId: uuid('source_event_id').references(() => gameEvents.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Ops tables
export const aiUsage = pgTable('ai_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  characterId: uuid('character_id').references(() => characters.id),
  userId: uuid('user_id').references(() => users.id),
  gameCycleId: uuid('game_cycle_id').references(() => gameCycles.id),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  purpose: text('purpose').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  latencyMs: integer('latency_ms'),
  estimatedCostCents: real('estimated_cost_cents'),
  success: boolean('success').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const moderationRecords = pgTable('moderation_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  directiveId: uuid('directive_id')
    .notNull()
    .references(() => directives.id),
  outcome: moderationOutcomeEnum('outcome').notNull(),
  reasonCategory: text('reason_category').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  target: text('target'),
  payload: jsonb('payload').default('{}'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Phase 13: one report per character per completed game day, generated
// by the strong model from that day's actual game_events rows only —
// never fabricated (§16). eventCount is stored alongside the prose so
// the UI/admin console can show "summarized from N events" without
// re-querying game_events.
export const dailyReports = pgTable('daily_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  characterId: uuid('character_id')
    .notNull()
    .references(() => characters.id),
  gameDay: integer('game_day').notNull(),
  summary: text('summary').notNull(),
  eventCount: integer('event_count').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
