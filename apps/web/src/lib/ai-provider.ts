import { loadConfig } from '@ai-world/shared';
import { MockProvider, AnthropicProvider, type AgentModelProvider } from '@ai-world/ai';

let _provider: AgentModelProvider | null = null;

/**
 * Same provider-selection rule as the simulation worker: mocked by
 * default, real Anthropic only when AI_USE_LIVE=true. The web app needs
 * this too — directive moderation (§13 of the build plan) runs here,
 * not just inside the tick loop.
 */
export function getAiProvider(): AgentModelProvider {
  if (_provider) return _provider;

  const config = loadConfig();
  _provider = config.AI_USE_LIVE
    ? new AnthropicProvider({
        apiKey: config.ANTHROPIC_API_KEY!,
        decisionModel: config.AI_DECISION_MODEL,
        dialogueModel: config.AI_DIALOGUE_MODEL,
        summaryModel: config.AI_SUMMARY_MODEL,
        premiumEnabled: config.AI_PREMIUM_ENABLED,
      })
    : new MockProvider();

  return _provider;
}
