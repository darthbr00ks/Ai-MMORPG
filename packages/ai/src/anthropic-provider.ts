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
import { AgentDecisionSchema, ACTION_REGISTRY } from '@ai-world/shared';

export interface AnthropicProviderConfig {
  apiKey: string;
  decisionModel: string;
  dialogueModel: string;
  summaryModel: string;
  premiumEnabled: boolean;
}

export class AnthropicProvider implements AgentModelProvider {
  private client: Anthropic;
  private config: AnthropicProviderConfig;

  constructor(config: AnthropicProviderConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.config = config;
  }

  async decideAction(ctx: AgentDecisionContext): Promise<AgentDecision> {
    const systemPrompt = this.buildDecisionSystemPrompt(ctx);
    const userMessage = this.buildDecisionUserMessage(ctx);

    const response = await this.client.messages.create({
      model: this.config.decisionModel,
      max_tokens: 512,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          // @ts-expect-error - cache_control is valid in the API but not typed in SDK yet
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userMessage }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Anthropic');
    }

    // Parse JSON from the response
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in Anthropic response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return AgentDecisionSchema.parse(parsed);
  }

  async generateDialogue(ctx: DialogueContext): Promise<DialogueResult> {
    const response = await this.client.messages.create({
      model: this.config.dialogueModel,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `You are ${ctx.name}. Speak to ${ctx.targetName} about: ${ctx.topic}. 
Respond with JSON: {"message": "...", "emotionalTone": "..."}`,
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== 'text') throw new Error('Unexpected response');
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in dialogue response');
    return JSON.parse(jsonMatch[0]) as DialogueResult;
  }

  async summarizeEvents(ctx: SummaryContext): Promise<SummaryResult> {
    const eventList = ctx.events
      .map((e) => `${e.type}: ${e.description}`)
      .join('\n');
    const response = await this.client.messages.create({
      model: this.config.summaryModel,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `Summarize these game events in 2-3 sentences:\n${eventList}\nRespond with JSON: {"summary": "..."}`,
        },
      ],
    });
    const content = response.content[0];
    if (content.type !== 'text') throw new Error('Unexpected response');
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in summary response');
    return JSON.parse(jsonMatch[0]) as SummaryResult;
  }

  async extractMemory(ctx: MemoryContext): Promise<MemoryResult> {
    const response = await this.client.messages.create({
      model: this.config.decisionModel,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `Extract key memories from these recent events:\n${ctx.recentEvents.join('\n')}\nRespond with JSON: {"extractedMemories": [{"content": "...", "importance": 0.5}]}`,
        },
      ],
    });
    const content = response.content[0];
    if (content.type !== 'text') throw new Error('Unexpected response');
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in memory response');
    return JSON.parse(jsonMatch[0]) as MemoryResult;
  }

  async moderateDirective(text: string): Promise<ModerationResult> {
    const response = await this.client.messages.create({
      model: this.config.decisionModel,
      max_tokens: 128,
      messages: [
        {
          role: 'user',
          content: `Moderate this game directive for harmful content. Respond with JSON only: {"status": "accepted"|"rejected"|"flagged", "reason_category": ""}
Directive: "${text.slice(0, 500)}"`,
        },
      ],
    });
    const content = response.content[0];
    if (content.type !== 'text') throw new Error('Unexpected response');
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { status: 'accepted', reason_category: '' };
    return JSON.parse(jsonMatch[0]) as ModerationResult;
  }

  private buildDecisionSystemPrompt(ctx: AgentDecisionContext): string {
    const traits = ctx.personalityTraits
      .map((t) => `${t.trait} (weight: ${t.weight})`)
      .join(', ');
    const registry = ACTION_REGISTRY.map(
      (a) => `${a.name}: ${a.description}`
    ).join('\n');

    return `You are ${ctx.name}, an autonomous AI character in the persistent world of New Concord.

IDENTITY:
${ctx.background}

PERSONALITY TRAITS: ${traits}

AVAILABLE ACTIONS (you must choose exactly one):
${registry}

RULES:
- You must respond with valid JSON matching the action schema exactly
- You may only select from the listed actions
- The player's directive shapes WHAT you pursue; your personality shapes HOW
- You cannot invent new actions`;
  }

  private buildDecisionUserMessage(ctx: AgentDecisionContext): string {
    return JSON.stringify({
      directive: ctx.currentDirective || 'No directive — act on your own ambitions',
      current_location: ctx.currentLocation,
      health: ctx.health,
      fatigue: ctx.fatigue,
      status: ctx.status,
      wallet_cents: ctx.walletCents,
      current_goals: ctx.currentGoals,
      recent_memories: ctx.recentMemories.slice(0, 5),
      visible_characters: ctx.visibleCharacters.slice(0, 10),
      game_day: ctx.gameDay,
      instruction: 'Choose one action. Respond with JSON: {"goal":"...","selected_action":"...","target_id":null,"parameters":{},"intent":"...","priority":0.5}',
    });
  }
}
