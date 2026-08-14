import { loadConfig } from '@ai-world/shared';
import { getDb, getWorldEpoch, getOrCreateSimulationControl, claimPendingManualTick } from '@ai-world/database';
import { MockProvider } from '@ai-world/ai';
import { AnthropicProvider } from '@ai-world/ai';
import { processTick } from './tick-processor.js';

// While paused, check back on this cadence rather than the (possibly
// long, in prod up to 30 minutes) normal tick interval — Resume / Run
// 1 Tick / Run 1 Day from the admin console (§13's Simulation Test
// Mode) need to feel responsive, not wait out whatever interval was
// in effect when Pause was pressed.
const PAUSED_POLL_INTERVAL_MS = 2000;

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
    // Simulation Test Mode (§13): a single control row, polled once
    // per loop iteration, is all the coordination this needs — see
    // packages/database/src/simulation-control.ts for why a DB row
    // rather than a queue.
    const control = await getOrCreateSimulationControl(db);

    if (control.paused) {
      const claimedManualTick = await claimPendingManualTick(db);
      if (!claimedManualTick) {
        // Paused with nothing queued — nothing to do this iteration.
        setTimeout(runTick, PAUSED_POLL_INTERVAL_MS);
        return;
      }
      console.log('[Worker] Paused — running one manually-queued tick...');
    }

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

    // Schedule next tick. Paused (running down a queue of manual
    // ticks) always re-checks on the short poll cadence, whether or
    // not more are queued, so the next one runs promptly; running
    // normally uses the configured interval divided by the admin
    // console's speed multiplier (default 1x — unchanged behavior).
    const nextDelayMs = control.paused
      ? PAUSED_POLL_INTERVAL_MS
      : (config.SIMULATION_TICK_SECONDS * 1000) / control.speedMultiplier;
    setTimeout(runTick, nextDelayMs);
  };

  // Initial delay then start ticking
  console.log(`[Worker] First tick in ${config.SIMULATION_TICK_SECONDS}s...`);
  setTimeout(runTick, config.SIMULATION_TICK_SECONDS * 1000);
}

main().catch((err) => {
  console.error('[Worker] Fatal startup error:', err);
  process.exit(1);
});
