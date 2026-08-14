import type {
  AgentDecisionContext,
  AgentDecision,
  DialogueContext,
  DialogueResult,
  SummaryContext,
  SummaryResult,
  MemoryContext,
  MemoryResult,
  ModerationResult,
  AiCallUsage,
} from '@ai-world/shared';

export interface AgentModelProvider {
  decideAction(ctx: AgentDecisionContext): Promise<AgentDecision>;
  generateDialogue(ctx: DialogueContext): Promise<DialogueResult>;
  summarizeEvents(ctx: SummaryContext): Promise<SummaryResult>;
  extractMemory(ctx: MemoryContext): Promise<MemoryResult>;
  moderateDirective(text: string): Promise<ModerationResult>;
  /**
   * Usage/cost for the most recently completed call on this provider
   * instance. Optional so MockProvider isn't forced to fake it — callers
   * that care about cost (the tick loop's ai_usage ledger + budget
   * breaker, §8) should treat a missing implementation as zero-cost.
   *
   * SAFE ONLY when calls to this provider instance are sequential.
   * Implementations (see AnthropicProvider) track this as one shared
   * `lastUsage` field overwritten on every call — decideAction and
   * generateDialogue rely on it and are called sequentially per
   * character in tick-processor.ts today, so it's fine there. Do NOT
   * use this method for a call site that runs concurrently across
   * characters against the same provider instance; the read can race
   * another character's concurrent call and attribute the wrong
   * cost/tokens. summarizeEvents and extractMemory are called
   * concurrently (daily-report.ts, memory-extraction.ts) and instead
   * return usage inline on their result (SummaryResult.usage /
   * MemoryResult.usage) for exactly this reason — prefer that pattern
   * for any future method a caller might parallelize.
   */
  getLastCallUsage?(): AiCallUsage | null;
}
