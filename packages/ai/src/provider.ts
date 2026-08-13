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
} from '@ai-world/shared';

export interface AgentModelProvider {
  decideAction(ctx: AgentDecisionContext): Promise<AgentDecision>;
  generateDialogue(ctx: DialogueContext): Promise<DialogueResult>;
  summarizeEvents(ctx: SummaryContext): Promise<SummaryResult>;
  extractMemory(ctx: MemoryContext): Promise<MemoryResult>;
  moderateDirective(text: string): Promise<ModerationResult>;
}
