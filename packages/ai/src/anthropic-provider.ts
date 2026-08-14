import Anthropic from '@anthropic-ai/sdk';
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
import type { AiCallUsage } from '@ai-world/shared';
import { AgentDecisionSchema, ACTION_REGISTRY, ACTION_SCHEMA } from '@ai-world/shared';
import { selectModel, type ModelRoutingConfig } from './model-router.js';

// Per-MTok pricing (§8 of the build plan). Cache reads run at ~0.1x base
// input rate; writes at ~1.25x. Matched by substring so date-suffixed or
// region-prefixed model IDs still price correctly.
const PRICING_PER_MTOK_CENTS: Array<{ match: string; input: number; output: number }> = [
  { match: 'haiku', input: 100, output: 500 },
  { match: 'sonnet', input: 300, output: 1500 },
  { match: 'opus', input: 500, output: 2500 },
];

function priceForModel(model: string) {
  return (
    PRICING_PER_MTOK_CENTS.find((p) => model.includes(p.match)) ?? {
      input: 300,
      output: 1500,
    }
  );
}

function computeUsage(model: string, usage: Anthropic.Usage): AiCallUsage {
  const price = priceForModel(model);
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;

  const costCents =
    (inputTokens * price.input) / 1_000_000 +
    (cacheReadTokens * price.input * 0.1) / 1_000_000 +
    (cacheWriteTokens * price.input * 1.25) / 1_000_000 +
    (outputTokens * price.output) / 1_000_000;

  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, estimatedCostCents: costCents };
}

export interface AnthropicProviderConfig {
  apiKey: string;
  decisionModel: string;
  dialogueModel: string;
  summaryModel: string;
  premiumEnabled: boolean;
}

const DIALOGUE_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    emotionalTone: { type: 'string' },
  },
  required: ['message', 'emotionalTone'],
  additionalProperties: false,
} as const;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: false,
} as const;

const MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    extractedMemories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          importance: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['content', 'importance'],
        additionalProperties: false,
      },
    },
  },
  required: ['extractedMemories'],
  additionalProperties: false,
} as const;

const MODERATION_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['accepted', 'rejected', 'flagged'] },
    reason_category: { type: 'string' },
  },
  required: ['status', 'reason_category'],
  additionalProperties: false,
} as const;

/**
 * Real Anthropic implementation. Every call uses `output_config.format`
 * (JSON Schema structured output) — never free-form text plus regex
 * extraction. "Never depend on free-form model output for gameplay"
 * (§4/§12 of the build plan) applies to every one of these, not just
 * decideAction: a malformed dialogue/summary/memory response is just as
 * capable of corrupting downstream state.
 */
export class AnthropicProvider implements AgentModelProvider {
  private client: Anthropic;
  private config: AnthropicProviderConfig;
  private routing: ModelRoutingConfig;
  private lastUsage: AiCallUsage | null = null;

  constructor(config: AnthropicProviderConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.config = config;
    this.routing = {
      decisionModel: config.decisionModel,
      dialogueModel: config.dialogueModel,
      summaryModel: config.summaryModel,
      premiumEnabled: config.premiumEnabled,
    };
  }

  getLastCallUsage(): AiCallUsage | null {
    return this.lastUsage;
  }

  async decideAction(ctx: AgentDecisionContext): Promise<AgentDecision> {
    const model = selectModel('decideAction', ctx, this.routing);
    const systemPrompt = this.buildDecisionSystemPrompt(ctx);
    const userMessage = this.buildDecisionUserMessage(ctx);

    const response = await this.client.messages.create({
      model,
      max_tokens: 512,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          // Identity/personality/registry are stable per character per
          // day (§4) — cached here; volatile state goes in `messages`,
          // after this breakpoint.
          cache_control: { type: 'ephemeral' },
        },
      ],
      output_config: { format: { type: 'json_schema', schema: ACTION_SCHEMA } },
      messages: [{ role: 'user', content: userMessage }],
    });

    const { parsed } = this.extractJson(response);
    return AgentDecisionSchema.parse(parsed);
  }

  async generateDialogue(ctx: DialogueContext): Promise<DialogueResult> {
    const model = selectModel('generateDialogue', {}, this.routing);
    const response = await this.client.messages.create({
      model,
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema: DIALOGUE_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: `You are ${ctx.name}. Speak to ${ctx.targetName} about: ${ctx.topic}.`,
        },
      ],
    });
    return this.extractJson(response).parsed as DialogueResult;
  }

  async summarizeEvents(ctx: SummaryContext): Promise<SummaryResult> {
    const model = selectModel('summarizeEvents', {}, this.routing);
    const eventList = ctx.events.map((e) => `${e.type}: ${e.description}`).join('\n');
    const response = await this.client.messages.create({
      model,
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
      messages: [
        { role: 'user', content: `Summarize these game events in 2-3 sentences:\n${eventList}` },
      ],
    });
    const { parsed, usage } = this.extractJson(response);
    // Returned inline (not just via getLastCallUsage) — daily-report.ts
    // calls this concurrently across characters; see provider.ts's doc
    // comment on getLastCallUsage for why the shared-field read alone
    // isn't safe under that concurrency.
    return { ...(parsed as SummaryResult), usage };
  }

  async extractMemory(ctx: MemoryContext): Promise<MemoryResult> {
    const model = selectModel('extractMemory', {}, this.routing);
    const response = await this.client.messages.create({
      model,
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema: MEMORY_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: `Extract key memories from these recent events:\n${ctx.recentEvents.join('\n')}`,
        },
      ],
    });
    const { parsed, usage } = this.extractJson(response);
    // Returned inline — memory-extraction.ts calls this concurrently
    // across characters; see the identical note in summarizeEvents above.
    return { ...(parsed as MemoryResult), usage };
  }

  async moderateDirective(text: string): Promise<ModerationResult> {
    const model = selectModel('moderateDirective', {}, this.routing);
    const response = await this.client.messages.create({
      model,
      max_tokens: 128,
      output_config: { format: { type: 'json_schema', schema: MODERATION_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: `Moderate this game directive for harmful content.\nDirective: "${text.slice(0, 500)}"`,
        },
      ],
    });
    try {
      return this.extractJson(response).parsed as ModerationResult;
    } catch {
      // Moderation failing open would be worse than failing closed —
      // flag for human review rather than silently accepting.
      return { status: 'flagged', reason_category: 'moderation_error' };
    }
  }

  /**
   * Structured-output responses are guaranteed valid JSON text — no
   * regex scraping. Returns usage alongside the parsed body (not just
   * via the `this.lastUsage` side effect) so callers that need a
   * concurrency-safe read — summarizeEvents, extractMemory — can use
   * the inline value instead of the shared field. The side effect on
   * `this.lastUsage` is kept for decideAction/generateDialogue/
   * moderateDirective, which only ever run sequentially per character
   * (see provider.ts's doc comment on getLastCallUsage).
   */
  private extractJson(response: Anthropic.Message): { parsed: unknown; usage: AiCallUsage } {
    const usage = computeUsage(response.model, response.usage);
    this.lastUsage = usage;

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Anthropic (expected structured text)');
    }
    return { parsed: JSON.parse(content.text), usage };
  }

  /**
   * IDENTITY + PERSONALITY + the action registry are stable for a given
   * character across its ~8 decision calls/day — this whole block is
   * what sits behind the cache breakpoint (§4/§8). It intentionally does
   * NOT include location/health/wallet/directive/memories — those change
   * every call and belong in the volatile user message instead, or the
   * cache is invalidated on every single request.
   */
  private buildDecisionSystemPrompt(ctx: AgentDecisionContext): string {
    const traits = ctx.personalityTraits
      .map((t) => `${t.trait} (weight: ${t.weight})`)
      .join(', ');
    const registry = ACTION_REGISTRY.map((a) => `${a.name}: ${a.description}`).join('\n');

    return `You are ${ctx.name}, an autonomous AI character in the persistent world of New Concord.

IDENTITY:
${ctx.background}

PERSONALITY TRAITS: ${traits}

AVAILABLE ACTIONS (you must choose exactly one):
${registry}

RULES:
- You may only select from the listed actions
- The player's directive shapes WHAT you pursue; your personality shapes HOW
- You cannot invent new actions
- A MOVE's target_id must be one of the exact slugs in this message's move_destinations_available — anything else is rejected and wastes the turn`;
  }

  private buildDecisionUserMessage(ctx: AgentDecisionContext): string {
    return JSON.stringify({
      directive: ctx.currentDirective || 'No directive — act on your own ambitions',
      current_location: ctx.currentLocation,
      // Location connections are one-directional (being reachable FROM
      // somewhere does not imply a path back) — this is the exhaustive,
      // authoritative list of valid MOVE target_ids from here. A MOVE
      // to anything else is rejected by the engine and wastes the call.
      move_destinations_available: ctx.connectedLocationSlugs,
      health: ctx.health,
      fatigue: ctx.fatigue,
      status: ctx.status,
      wallet_cents: ctx.walletCents,
      current_goals: ctx.currentGoals,
      recent_memories: ctx.recentMemories.slice(0, 5),
      visible_characters: ctx.visibleCharacters.slice(0, 10),
      active_conversations: ctx.activeConversations.slice(0, 5),
      available_market_items: ctx.availableMarketItems,
      game_day: ctx.gameDay,
    });
  }
}
