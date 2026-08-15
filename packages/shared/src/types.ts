import { z } from 'zod';

export const DirectiveSchema = z.object({
  text: z
    .string()
    .min(1, 'Directive cannot be empty')
    .max(500, 'Directive must be 500 characters or fewer'),
});

export type DirectiveInput = z.infer<typeof DirectiveSchema>;

export const CharacterStatusEnum = z.enum([
  'idle',
  'working',
  'traveling',
  'conversing',
  'sleeping',
  'planning',
]);

export type CharacterStatus = z.infer<typeof CharacterStatusEnum>;

export const ModerationOutcomeEnum = z.enum([
  'accepted',
  'rejected',
  'flagged',
]);

export type ModerationOutcome = z.infer<typeof ModerationOutcomeEnum>;

export const ValidationResultEnum = z.enum(['valid', 'rejected', 'fallback']);

export type ValidationResult = z.infer<typeof ValidationResultEnum>;

export interface PersonalityTrait {
  trait: string;
  weight: number; // 0..1
}

/** A character visible at the same location — enough for the model to
 * name a `target_id` for START_CONVERSATION without leaking anything
 * beyond what a character standing in the same room could observe. */
export interface VisibleCharacter {
  characterId: string;
  name: string;
}

/** A conversation this character is already part of and can continue
 * via CONTINUE_CONVERSATION (target_id = conversationId). Carries just
 * enough of the last exchange for the model to respond in context —
 * never the full transcript (§5's token-minimization constraint). */
export interface ActiveConversationSummary {
  conversationId: string;
  otherCharacterName: string;
  lastMessage: string | null;
}

/** An item the NPC market at the current location will buy/sell — the
 * model needs the id to address BUY_ITEM/SELL_ITEM's target_id, and
 * the price to reason about whether it's worth it. Phase 12 ships one
 * fixed catalog, world-wide, not a per-location assortment. */
export interface AvailableMarketItem {
  itemId: string;
  name: string;
  basePriceCents: number;
}

export interface AgentDecisionContext {
  characterId: string;
  name: string;
  background: string;
  personalityTraits: PersonalityTrait[];
  skills: string[];
  ambitions: string[];
  currentDirective: string | null;
  currentLocation: string;
  // The ONLY destinations a MOVE from currentLocation can actually
  // validate against (action-validator.ts's isLocationConnected checks
  // exactly this list, one-directional — a location being IN another's
  // connections list does not imply the reverse). Without this, nothing
  // in the decision context tells the model which MOVE targets are
  // reachable from here, so it can only find out by guessing and
  // getting an ACTION_REJECTED back — a real, wasted AI call under
  // AnthropicProvider, not just a MockProvider quirk that ended up
  // stuck against a location with no direct path back to town-square
  // (`bank`/`mine` in the seed data — see docs/architecture.md).
  connectedLocationSlugs: string[];
  health: number;
  fatigue: number;
  status: CharacterStatus;
  walletCents: number;
  currentGoals: string[];
  recentMemories: string[];
  availableActions: string[];
  visibleCharacters: VisibleCharacter[];
  availableMarketItems: AvailableMarketItem[];
  activeConversations: ActiveConversationSummary[];
  gameCycleId: string;
  gameDay: number;
}

export interface DialogueContext {
  characterId: string;
  name: string;
  personalityTraits: PersonalityTrait[];
  targetCharacterId: string;
  targetName: string;
  relationship: Record<string, number>;
  topic: string;
  gameCycleId: string;
}

export interface SummaryContext {
  characterId: string;
  events: Array<{ type: string; description: string; createdAt: Date }>;
  gameCycleId: string;
}

export interface MemoryContext {
  characterId: string;
  recentEvents: string[];
  existingMemories: string[];
  gameCycleId: string;
}

export interface DialogueResult {
  message: string;
  emotionalTone: string;
}

export interface SummaryResult {
  summary: string;
  // Per-call usage, returned inline rather than fetched afterward via
  // provider.getLastCallUsage() — see AgentModelProvider's doc comment
  // for why: summarizeEvents is called once per character per day
  // rollover, and the caller (daily-report.ts) runs those calls
  // concurrently across characters. A provider that tracked usage as
  // shared instance state (one `lastUsage` field, overwritten by
  // whichever call finishes last) would silently mis-attribute cost
  // between characters under that concurrency. Optional so a provider
  // that only ever runs sequentially (or doesn't track cost, like
  // MockProvider) isn't forced to populate it.
  usage?: AiCallUsage;
}

export interface MemoryResult {
  extractedMemories: Array<{ content: string; importance: number }>;
  // See SummaryResult.usage — extractMemory has the identical
  // concurrent-per-character calling pattern in memory-extraction.ts.
  usage?: AiCallUsage;
}

export interface ModerationResult {
  status: ModerationOutcome;
  reason_category: string;
}

/**
 * Real per-call token/cost accounting (§8 of the build plan — "AI cost
 * is a first-class metric"). Mock provider reports zeros (it's free);
 * AnthropicProvider computes this from the SDK response's `usage` block
 * and the model's per-MTok pricing.
 */
export interface AiCallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostCents: number;
}

export const GameEventTypes = [
  'CHARACTER_MOVED',
  'JOB_COMPLETED',
  'MONEY_EARNED',
  'RELATIONSHIP_CHANGED',
  'DIRECTIVE_SUBMITTED',
  'DIRECTIVE_MODERATED',
  'ACTION_EXECUTED',
  'ACTION_REJECTED',
  'CHARACTER_IDLE',
  'CONVERSATION_STARTED',
  'CONVERSATION_MESSAGE',
  'CONVERSATION_ENDED',
  'ITEM_PURCHASED',
  'ITEM_SOLD',
  'ITEM_GIVEN',
  'MONEY_TRANSFERRED',
  'SIMULATION_TICK_STARTED',
  'SIMULATION_TICK_COMPLETED',
  'FACTION_FOUNDED',
  'FACTION_MEMBER_JOINED',
  'LEADERSHIP_CHALLENGED',
  'ROMANCE_EXPRESSED',
  'CHALLENGE_ISSUED',
] as const;

export type GameEventType = (typeof GameEventTypes)[number];
