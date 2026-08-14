import { eq, and } from 'drizzle-orm';
import type { Db } from '@ai-world/database';
import {
  characters,
  characterState,
  wallets,
  directives,
  agentDecisions,
  agentActions,
  gameEvents,
  gameCycles,
  locations,
  aiUsage,
} from '@ai-world/database';
import type { AgentModelProvider } from '@ai-world/ai';
import { validateAction } from '@ai-world/game-engine';
import { creditWallet } from '@ai-world/game-engine';
import type { AgentDecision, AgentDecisionContext } from '@ai-world/shared';
import { AgentDecisionSchema } from '@ai-world/shared';
import { gameTimeNow } from '@ai-world/shared';

export interface TickConfig {
  gameDayRealSeconds: number;
  simulationTickSeconds: number;
  dailyBudgetCents: number;
  providerName: string;
  modelName: string;
}

export interface TickResult {
  cycleId: string;
  processedCharacters: number;
  errors: string[];
  budgetExceeded: boolean;
}

export async function processTick(
  db: Db,
  provider: AgentModelProvider,
  config: TickConfig,
  cycleStartedAt: Date
): Promise<TickResult> {
  const errors: string[] = [];

  // Get or create game cycle
  const gameTime = gameTimeNow(cycleStartedAt, config.gameDayRealSeconds);

  const existingCycles = await db
    .select()
    .from(gameCycles)
    .where(eq(gameCycles.dayNumber, gameTime.day))
    .limit(1);

  let cycleId: string;
  if (existingCycles.length > 0) {
    cycleId = existingCycles[0].id;
  } else {
    const [newCycle] = await db
      .insert(gameCycles)
      .values({ dayNumber: gameTime.day, startedAt: new Date() })
      .returning({ id: gameCycles.id });
    cycleId = newCycle.id;
  }

  // Load all locations for movement validation
  const allLocations = await db.select().from(locations);
  const locationMap = new Map(allLocations.map((l) => [l.id, l]));

  // Build location slug map for validation
  const locationsBySlug = allLocations.map((l) => ({
    id: l.id,
    slug: l.slug,
    connections: (l.connections as string[]) || [],
  }));

  // Check daily budget
  let totalSpentCents = 0;
  let budgetExceeded = false;

  // Load all characters with state
  const allCharacters = await db
    .select({
      id: characters.id,
      name: characters.name,
      background: characters.background,
      personalityTraits: characters.personalityTraits,
      skills: characters.skills,
      ambitions: characters.ambitions,
    })
    .from(characters);

  let processedCount = 0;

  for (const char of allCharacters) {
    try {
      // Check budget before each character's AI call
      if (totalSpentCents >= config.dailyBudgetCents) {
        if (!budgetExceeded) {
          budgetExceeded = true;
          console.warn(`[Tick] Daily budget exceeded (${config.dailyBudgetCents} cents). Remaining characters will IDLE.`);
        }
        // Write IDLE fallback
        await writeIdleFallback(db, char.id, cycleId, 'budget_exceeded');
        processedCount++;
        continue;
      }

      // Load character state
      const [state] = await db
        .select()
        .from(characterState)
        .where(eq(characterState.characterId, char.id))
        .limit(1);

      if (!state) {
        errors.push(`No state for character ${char.id} (${char.name})`);
        continue;
      }

      // Check if traveling and not arrived yet. Per §12 of the build
      // plan, a traveling character does NOT get an AI decision call
      // every tick — but the tick engine still correctly considered
      // and handled them, so they count toward processedCharacters.
      // (Previously this `continue` skipped the processedCount++ at
      // the bottom of the loop entirely, so any tick with a character
      // mid-travel silently under-reported its own processed count —
      // a false signal for anything monitoring "did this tick cover
      // everyone".)
      if (state.status === 'traveling' && state.travelEta && state.travelEta > new Date()) {
        processedCount++;
        continue;
      }

      // Complete travel if arrived
      if (state.status === 'traveling' && state.travelDestinationId) {
        await db
          .update(characterState)
          .set({
            locationId: state.travelDestinationId,
            status: 'idle',
            travelEta: null,
            travelDestinationId: null,
            updatedAt: new Date(),
          })
          .where(eq(characterState.characterId, char.id));

        const destLoc = locationMap.get(state.travelDestinationId);
        await db.insert(gameEvents).values({
          type: 'CHARACTER_MOVED',
          actorCharacterId: char.id,
          locationId: state.travelDestinationId,
          payload: {
            from_location_id: state.locationId,
            to_location_id: state.travelDestinationId,
            to_location_name: destLoc?.name,
          },
          importance: 0.2,
          createdAt: new Date(),
        });
      }

      // Reload state after travel resolution
      const [freshState] = await db
        .select()
        .from(characterState)
        .where(eq(characterState.characterId, char.id))
        .limit(1);

      const currentState = freshState || state;
      const currentLocation = locationMap.get(currentState.locationId);

      // Load wallet
      const [wallet] = await db
        .select()
        .from(wallets)
        .where(eq(wallets.characterId, char.id))
        .limit(1);

      // Load active directive
      const [activeDirective] = await db
        .select()
        .from(directives)
        .where(
          and(
            eq(directives.characterId, char.id),
            eq(directives.active, true)
          )
        )
        .limit(1);

      const ctx: AgentDecisionContext = {
        characterId: char.id,
        name: char.name,
        background: char.background,
        personalityTraits: (char.personalityTraits as Array<{ trait: string; weight: number }>) || [],
        skills: (char.skills as string[]) || [],
        ambitions: (char.ambitions as string[]) || [],
        currentDirective: activeDirective?.text || null,
        currentLocation: currentLocation?.slug || 'unknown',
        health: currentState.health,
        fatigue: currentState.fatigue,
        status: currentState.status,
        walletCents: wallet?.balanceCents || 0,
        currentGoals: (char.ambitions as string[]) || [],
        recentMemories: [],
        availableActions: ['IDLE', 'MOVE', 'WORK'],
        visibleCharacters: [],
        gameCycleId: cycleId,
        gameDay: gameTime.day,
      };

      // Call AI provider with timing
      const startMs = Date.now();
      let decision: AgentDecision;
      let aiSuccess = true;
      let retryUsed = false;

      try {
        decision = await provider.decideAction(ctx);
        // Validate schema
        AgentDecisionSchema.parse(decision);
      } catch (aiErr) {
        // One corrective retry with cheap/fallback
        try {
          retryUsed = true;
          decision = await provider.decideAction({
            ...ctx,
            currentGoals: [...ctx.currentGoals, `RETRY: ${String(aiErr).slice(0, 100)}`],
          });
          AgentDecisionSchema.parse(decision);
        } catch {
          // Final fallback: IDLE
          aiSuccess = false;
          decision = {
            goal: 'fallback',
            selected_action: 'IDLE',
            target_id: null,
            parameters: {},
            intent: 'Provider error — falling back to IDLE',
            priority: 0,
          };
        }
      }

      const latencyMs = Date.now() - startMs;

      // Real per-call usage/cost (§8) — MockProvider doesn't implement
      // getLastCallUsage, so a missing implementation is zero cost, not
      // an error. AnthropicProvider always reports it after a call.
      const usage = provider.getLastCallUsage?.() ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostCents: 0,
      };
      totalSpentCents += usage.estimatedCostCents;

      await db.insert(aiUsage).values({
        characterId: char.id,
        gameCycleId: cycleId,
        provider: config.providerName,
        model: config.modelName,
        purpose: 'decideAction',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        latencyMs,
        estimatedCostCents: usage.estimatedCostCents,
        success: aiSuccess,
        createdAt: new Date(),
      });

      // Validate action against game rules
      const worldState = {
        locations: locationsBySlug,
        currentGameDay: gameTime.day,
      };

      const validation = validateAction(
        decision,
        {
          id: char.id,
          locationSlug: currentLocation?.slug || 'unknown',
          status: currentState.status,
          walletCents: wallet?.balanceCents || 0,
          health: currentState.health,
          fatigue: currentState.fatigue,
        },
        worldState
      );

      // Write agent decision record
      const [decisionRecord] = await db
        .insert(agentDecisions)
        .values({
          characterId: char.id,
          gameCycleId: cycleId,
          contextSummary: {
            location: currentLocation?.slug,
            health: currentState.health,
            fatigue: currentState.fatigue,
            walletCents: wallet?.balanceCents,
            directive: activeDirective?.text?.slice(0, 100),
          },
          model: config.modelName,
          chosenAction: decision.selected_action,
          targetId: decision.target_id || null,
          latencyMs,
          createdAt: new Date(),
        })
        .returning({ id: agentDecisions.id });

      // Write action record
      await db.insert(agentActions).values({
        decisionId: decisionRecord.id,
        actionType: decision.selected_action,
        payload: {
          intent: decision.intent,
          goal: decision.goal,
          parameters: decision.parameters,
          target_id: decision.target_id,
          retry_used: retryUsed,
        },
        validationResult: validation.valid ? 'valid' : 'rejected',
        executedAt: new Date(),
      });

      // Execute valid actions
      if (validation.valid) {
        await executeAction(
          db,
          char.id,
          decision,
          currentState,
          locationsBySlug,
          cycleId,
          config.gameDayRealSeconds
        );
      } else {
        // Write rejected event
        await db.insert(gameEvents).values({
          type: 'ACTION_REJECTED',
          actorCharacterId: char.id,
          locationId: currentState.locationId,
          payload: { action: decision.selected_action, reason: validation.reason },
          importance: 0.1,
          createdAt: new Date(),
        });
      }

      processedCount++;
    } catch (err) {
      const errMsg = `Character ${char.id} (${char.name}): ${String(err)}`;
      errors.push(errMsg);
      console.error(`[Tick] Error processing character: ${errMsg}`);
      // Continue to next character — one broken character never kills the tick
    }
  }

  // Mark cycle as ended
  await db
    .update(gameCycles)
    .set({ endedAt: new Date() })
    .where(eq(gameCycles.id, cycleId));

  return { cycleId, processedCharacters: processedCount, errors, budgetExceeded };
}

async function writeIdleFallback(
  db: Db,
  characterId: string,
  cycleId: string,
  reason: string
): Promise<void> {
  const [dec] = await db
    .insert(agentDecisions)
    .values({
      characterId,
      gameCycleId: cycleId,
      contextSummary: { fallback_reason: reason },
      model: 'fallback',
      chosenAction: 'IDLE',
      latencyMs: 0,
      createdAt: new Date(),
    })
    .returning({ id: agentDecisions.id });

  await db.insert(agentActions).values({
    decisionId: dec.id,
    actionType: 'IDLE',
    payload: { reason },
    validationResult: 'fallback',
    executedAt: new Date(),
  });
}

interface LocationInfo {
  id: string;
  slug: string;
  connections: string[];
}

// A MOVE takes this many simulated hours, converted to real ms via the
// game clock — never a hardcoded real-world constant. At the default
// GAME_DAY_REAL_SECONDS=300 (dev), 2 simulated hours is 25 real seconds;
// in production (86400s/day) it's 2 real hours, which is the intent.
const MOVE_DURATION_GAME_HOURS = 2;

function moveDurationMs(gameDayRealSeconds: number): number {
  return (MOVE_DURATION_GAME_HOURS / 24) * gameDayRealSeconds * 1000;
}

async function executeAction(
  db: Db,
  characterId: string,
  decision: AgentDecision,
  state: { locationId: string; status: string },
  locations: LocationInfo[],
  cycleId: string,
  gameDayRealSeconds: number
): Promise<void> {
  switch (decision.selected_action) {
    case 'IDLE': {
      await db
        .update(characterState)
        .set({ status: 'idle', updatedAt: new Date() })
        .where(eq(characterState.characterId, characterId));

      await db.insert(gameEvents).values({
        type: 'CHARACTER_IDLE',
        actorCharacterId: characterId,
        locationId: state.locationId,
        payload: { intent: decision.intent, goal: decision.goal },
        importance: 0.1,
        createdAt: new Date(),
      });
      break;
    }

    case 'MOVE': {
      const destSlug = decision.target_id;
      if (!destSlug) return;

      const destLoc = locations.find((l) => l.slug === destSlug);
      if (!destLoc) return;

      const travelEta = new Date(Date.now() + moveDurationMs(gameDayRealSeconds));

      await db
        .update(characterState)
        .set({
          status: 'traveling',
          travelEta,
          travelDestinationId: destLoc.id,
          updatedAt: new Date(),
        })
        .where(eq(characterState.characterId, characterId));

      await db.insert(gameEvents).values({
        type: 'CHARACTER_MOVED',
        actorCharacterId: characterId,
        locationId: state.locationId,
        payload: {
          destination: destSlug,
          destination_id: destLoc.id,
          eta: travelEta.toISOString(),
          intent: decision.intent,
        },
        importance: 0.2,
        createdAt: new Date(),
      });
      break;
    }

    case 'WORK': {
      // Earn wages: 50-200 cents per tick
      const wages = 50 + Math.floor(Math.random() * 150);

      const [wallet] = await db
        .select()
        .from(wallets)
        .where(eq(wallets.characterId, characterId))
        .limit(1);

      if (wallet) {
        await creditWallet(db, characterId, wages, 'Work wages');
      }

      // Increase fatigue
      const [cs] = await db
        .select()
        .from(characterState)
        .where(eq(characterState.characterId, characterId))
        .limit(1);

      if (cs) {
        await db
          .update(characterState)
          .set({
            status: 'working',
            fatigue: Math.min(100, cs.fatigue + 10),
            updatedAt: new Date(),
          })
          .where(eq(characterState.characterId, characterId));
      }

      await db.insert(gameEvents).values({
        type: 'MONEY_EARNED',
        actorCharacterId: characterId,
        locationId: state.locationId,
        payload: { amount_cents: wages, intent: decision.intent },
        importance: 0.3,
        createdAt: new Date(),
      });
      break;
    }
  }
}
