import type { AgentDecisionContext } from '@ai-world/shared';

export type ModelTier = 'cheap' | 'strong' | 'premium';

export interface ModelRoutingConfig {
  decisionModel: string;
  dialogueModel: string;
  summaryModel: string;
  premiumEnabled: boolean;
  premiumModel?: string;
}

/**
 * Single function for model routing — not scattered call sites.
 * Returns the model ID to use for a given purpose and context.
 */
export function selectModel(
  purpose: 'decideAction' | 'generateDialogue' | 'summarizeEvents' | 'extractMemory' | 'moderateDirective',
  ctx: Partial<AgentDecisionContext>,
  config: ModelRoutingConfig
): string {
  switch (purpose) {
    case 'decideAction': {
      // Use strong model for complex characters (ambitious + manipulative traits)
      const isComplex =
        ctx.personalityTraits?.some(
          (t) =>
            (t.trait === 'ambitious' || t.trait === 'manipulative') &&
            t.weight > 0.75
        ) ?? false;
      return isComplex ? config.dialogueModel : config.decisionModel;
    }
    case 'generateDialogue':
    case 'summarizeEvents':
      return config.dialogueModel;
    case 'extractMemory':
    case 'moderateDirective':
      return config.decisionModel;
    default:
      return config.decisionModel;
  }
}
