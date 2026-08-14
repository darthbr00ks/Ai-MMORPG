import type { AgentModelProvider } from './provider.js';
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

/**
 * MockProvider: deterministic canned responses for testing.
 * Includes occasional malformed output to exercise the fallback path.
 * Zero cost — default provider.
 */
export class MockProvider implements AgentModelProvider {
  private callCount = 0;

  async decideAction(ctx: AgentDecisionContext): Promise<AgentDecision> {
    this.callCount++;

    // Every 7th call returns malformed output to test the fallback path
    if (this.callCount % 7 === 0) {
      throw new Error('MockProvider: simulated malformed/timeout error');
    }

    // Every 3rd call, prefer the social loop over the economic one below
    // — deterministic, so it actually exercises START_CONVERSATION /
    // CONTINUE_CONVERSATION end-to-end in dev and tests, not just in
    // principle. An open conversation always wins over starting a new
    // one (finish what you started before talking to someone else).
    if (this.callCount % 3 === 0) {
      const openConversation = ctx.activeConversations[0];
      if (openConversation) {
        return {
          goal: 'continue the conversation',
          selected_action: 'CONTINUE_CONVERSATION',
          target_id: openConversation.conversationId,
          parameters: {},
          intent: `Responding to ${openConversation.otherCharacterName}`,
          priority: 0.6,
        };
      }
      const nearbyCharacter = ctx.visibleCharacters[0];
      if (nearbyCharacter) {
        return {
          goal: 'get to know the people around me',
          selected_action: 'START_CONVERSATION',
          target_id: nearbyCharacter.characterId,
          parameters: { topic: 'general' },
          intent: `Striking up a conversation with ${nearbyCharacter.name}`,
          priority: 0.5,
        };
      }
    }

    // Vary behavior based on personality traits and directive
    const hasDirective = ctx.currentDirective && ctx.currentDirective.length > 0;
    const isAmbitious = ctx.personalityTraits.some(
      (t) => t.trait === 'ambitious' && t.weight > 0.7
    );

    // Simple deterministic logic: prefer WORK if directive mentions wealth,
    // MOVE if current location has been visited, IDLE otherwise
    let action: AgentDecision['selected_action'] = 'IDLE';
    let goal = 'rest and observe';
    let intent = 'Taking time to plan next move';

    if (hasDirective && ctx.currentDirective!.toLowerCase().includes('wealth')) {
      action = 'WORK';
      goal = 'accumulate wealth as directed';
      intent = 'Working to earn money as the player directed';
    } else if (hasDirective && ctx.currentDirective!.toLowerCase().includes('move')) {
      action = 'MOVE';
      goal = 'relocate as directed';
      intent = 'Moving to seek opportunities';
    } else if (isAmbitious && ctx.currentLocation !== 'city-hall') {
      action = 'MOVE';
      goal = 'seek power and influence';
      intent = 'Moving toward the seat of power';
    } else if (ctx.walletCents < 5000) {
      action = 'WORK';
      goal = 'earn more money';
      intent = 'Working to secure financial stability';
    } else if (ctx.currentLocation === 'market' && ctx.availableMarketItems.length > 0) {
      // Comfortably wealthy (the wallet < 5000 branch above didn't
      // fire) and standing at the one place BUY_ITEM is legal —
      // exercises the Phase 12 economy actions in dev/tests without a
      // separate modulo-cadence gate like the social loop above.
      action = 'BUY_ITEM';
      goal = 'stock up on supplies';
      intent = `Buying ${ctx.availableMarketItems[0].name.toLowerCase()} at the market`;
    }

    // For MOVE, use the first visible character's location or a safe default.
    // Fall back to WORK if already at town-square (can't always move there).
    if (action === 'MOVE') {
      const destination =
        ctx.currentLocation !== 'town-square' ? 'town-square' : 'tavern';
      return {
        goal,
        selected_action: 'MOVE',
        target_id: destination,
        parameters: {},
        intent,
        priority: isAmbitious ? 0.8 : 0.5,
      };
    }

    if (action === 'BUY_ITEM') {
      const item = ctx.availableMarketItems[0];
      return {
        goal,
        selected_action: 'BUY_ITEM',
        target_id: item.itemId,
        parameters: { quantity: 1 },
        intent,
        priority: 0.4,
      };
    }

    return {
      goal,
      selected_action: action,
      target_id: null,
      parameters: {},
      intent,
      priority: isAmbitious ? 0.8 : 0.5,
    };
  }

  async generateDialogue(ctx: DialogueContext): Promise<DialogueResult> {
    return {
      message: `Greetings, ${ctx.targetName}. I hope we can work together.`,
      emotionalTone: 'neutral',
    };
  }

  async summarizeEvents(ctx: SummaryContext): Promise<SummaryResult> {
    const count = ctx.events.length;
    return {
      summary: `Character participated in ${count} events this cycle.`,
    };
  }

  async extractMemory(ctx: MemoryContext): Promise<MemoryResult> {
    return {
      extractedMemories: ctx.recentEvents.slice(0, 2).map((e) => ({
        content: e,
        importance: 0.5,
      })),
    };
  }

  async moderateDirective(text: string): Promise<ModerationResult> {
    // Simple mock: reject if contains obviously bad words
    const badWords = ['kill all', 'destroy everything', 'hack the'];
    const lower = text.toLowerCase();
    for (const bad of badWords) {
      if (lower.includes(bad)) {
        return { status: 'rejected', reason_category: 'harmful_content' };
      }
    }
    return { status: 'accepted', reason_category: '' };
  }
}
