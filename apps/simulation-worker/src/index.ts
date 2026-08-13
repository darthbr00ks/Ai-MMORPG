import { loadConfig } from '@ai-world/shared';
import { getDb, getWorldEpoch } from '@ai-world/database';
import { MockProvider } from '@ai-world/ai';
import { AnthropicProvider } from '@ai-world/ai';
import { processTick } from './tick-processor.js';

async function main() {
  const config = loadConfig();
  console.log('[Worker] Starting simulation worker...');
  console.log(`[Worker] Game day: ${config.GAME_DAY_REAL_SECONDS}s real time`);
  console.log(`[Worker] Tick interval: ${config.SIMULATION_TICK_SECONDS}s`);
  console.log(`[Worker] AI provider: ${config.AI_USE_LIVE ? 'Anthropic (LIVE)' : 'Mock (free)'}`);

  const db = getDb();

  const provider = config.AI_USE_LIVE
    ? new AnthropicProvider({
        apiKey: config.ANTHROPIC_API_KEY!,
        decisionModel: config.AI_DECISION_MODEL,
        dialogueModel: config.AI_DIALOGUE_MODEL,
        summaryModel: config.AI_SUMMARY_MODEL,
        premiumEnabled: config.AI_PREMIUM_ENABLED,
      })
    : new MockProvider();

  // World epoch is persisted in game_cycles (day 0) — never a fresh
  // in-memory Date — so the game day survives a worker restart and the
  // web app can compute the same "today" independently.
  const cycleStartedAt = await getWorldEpoch(db);
  console.log(`[Worker] World epoch: ${cycleStartedAt.toISOString()}`);
  let tickCount = 0;

  const runTick = async () => {
    tickCount++;
    const tickId = `tick-${tickCount}`;
    console.log(`[Worker] ${tickId} starting...`);

    try {
      const result = await processTick(db, provider, {
        gameDayRealSeconds: config.GAME_DAY_REAL_SECONDS,
        simulationTickSeconds: config.SIMULATION_TICK_SECONDS,
        dailyBudgetCents: config.AI_DAILY_BUDGET_CENTS,
        providerName: config.AI_USE_LIVE ? 'anthropic' : 'mock',
        modelName: config.AI_USE_LIVE ? config.AI_DECISION_MODEL : 'mock',
      }, cycleStartedAt);

      console.log(
        `[Worker] ${tickId} complete: ${result.processedCharacters} characters, ${result.errors.length} errors, cycle=${result.cycleId}`
      );

      if (result.errors.length > 0) {
        for (const err of result.errors) {
          console.error(`[Worker] Error: ${err}`);
        }
      }
    } catch (err) {
      console.error(`[Worker] Tick ${tickId} FATAL error (tick survived):`, err);
    }

    // Schedule next tick
    setTimeout(runTick, config.SIMULATION_TICK_SECONDS * 1000);
  };

  // Initial delay then start ticking
  console.log(`[Worker] First tick in ${config.SIMULATION_TICK_SECONDS}s...`);
  setTimeout(runTick, config.SIMULATION_TICK_SECONDS * 1000);
}

main().catch((err) => {
  console.error('[Worker] Fatal startup error:', err);
  process.exit(1);
});
