import { eq, and, isNull, inArray, desc } from 'drizzle-orm';
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
  conversations,
  conversationMessages,
  memories,
} from '@ai-world/database';
import type { AgentModelProvider } from '@ai-world/ai';
import { validateAction, applyRelationshipEffect, getRelationship } from '@ai-world/game-engine';
import { creditWallet } from '@ai-world/game-engine';
import { extractDailyMemories } from './memory-extraction.js';
import type {
  AgentDecision,
  AgentDecisionContext,
  ActiveConversationSummary,
  VisibleCharacter,
} from '@ai-world/shared';
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

    // A new day just started — the natural once-per-day hook for
    // memory extraction (§5/§8: periodic, NOT per decision tick). Runs
    // synchronously so ai_usage/cost for it is attributed to the day
    // that just ended before this tick moves on to today's decisions.
    //
    // Only extracts the single day immediately prior — if the worker
    // was offline long enough to skip multiple day boundaries (over a
    // full GAME_DAY_REAL_SECONDS), the memories for the skipped days
    // in between are not backfilled. That day's game_events are never
    // lost, only the memory summarization of them; an outage long
    // enough to trigger this is already an ops incident worth its own
    // attention, and a bounded catch-up loop here is more complexity
    // than an alpha needs (§16: "don't build mature-world infra during
    // alpha").
    if (gameTime.day > 0) {
      const memoryResult = await extractDailyMemories(
        db,
        provider,
        gameTime.day - 1,
        config.providerName,
        config.modelName,
        cycleStartedAt,
        config.gameDayRealSeconds
      );
      errors.push(...memoryResult.errors.map((e) => `[daily-memory-extraction] ${e}`));
    }
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

  const characterNameById = new Map(allCharacters.map((c) => [c.id, c.name]));

  // --- Conversation visibility & context (§5, §10) ---------------------
  // Batch-loaded once per tick rather than per character: with 20+
  // characters this turns what would be O(characters) extra round trips
  // into 3 fixed queries.

  // Who's standing where right now — a character mid-travel isn't
  // "at" either location, so they're excluded from both origin and
  // destination visibility until they arrive.
  const allCharacterLocations = await db
    .select({
      characterId: characterState.characterId,
      locationId: characterState.locationId,
      status: characterState.status,
    })
    .from(characterState);

  const characterIdsByLocationId = new Map<string, string[]>();
  for (const row of allCharacterLocations) {
    if (row.status === 'traveling') continue;
    const occupants = characterIdsByLocationId.get(row.locationId) ?? [];
    occupants.push(row.characterId);
    characterIdsByLocationId.set(row.locationId, occupants);
  }

  // Every conversation still open (no endedAt), plus its messages, so
  // each character's activeConversations can carry the last line
  // without a per-character query.
  const openConversationRows = await db
    .select()
    .from(conversations)
    .where(isNull(conversations.endedAt));

  const conversationInfoById = new Map<
    string,
    { participantIds: string[]; locationId: string | null }
  >();
  for (const row of openConversationRows) {
    conversationInfoById.set(row.id, {
      participantIds: (row.participantIds as string[]) ?? [],
      locationId: row.locationId,
    });
  }

  const openConversationIds = openConversationRows.map((c) => c.id);
  const messagesByConversationId = new Map<
    string,
    { characterId: string; content: string; createdAt: Date }[]
  >();
  if (openConversationIds.length > 0) {
    const openMessages = await db
      .select()
      .from(conversationMessages)
      .where(inArray(conversationMessages.conversationId, openConversationIds))
      .orderBy(conversationMessages.createdAt);
    for (const msg of openMessages) {
      const bucket = messagesByConversationId.get(msg.conversationId) ?? [];
      bucket.push({ characterId: msg.characterId, content: msg.content, createdAt: msg.createdAt });
      messagesByConversationId.set(msg.conversationId, bucket);
    }
  }
  // Running count per conversation, incremented in-memory as new
  // messages are written during this tick's loop — keeps the
  // 6-message cap (see executeAction) accurate even if two
  // participants of the same conversation are both processed in the
  // same tick, without re-querying per write.
  const conversationMessageCounts = new Map<string, number>(
    Array.from(messagesByConversationId.entries()).map(([id, msgs]) => [id, msgs.length])
  );

  const activeConversationsByCharacterId = new Map<string, ActiveConversationSummary[]>();
  for (const [conversationId, info] of conversationInfoById) {
    const messages = messagesByConversationId.get(conversationId) ?? [];
    const lastMessage = messages.length > 0 ? messages[messages.length - 1].content : null;
    for (const participantId of info.participantIds) {
      const otherId = info.participantIds.find((id) => id !== participantId) ?? null;
      const summary: ActiveConversationSummary = {
        conversationId,
        otherCharacterName: otherId ? characterNameById.get(otherId) ?? 'someone' : 'someone',
        lastMessage,
      };
      const existing = activeConversationsByCharacterId.get(participantId) ?? [];
      existing.push(summary);
      activeConversationsByCharacterId.set(participantId, existing);
    }
  }

  // Most recent memories per character, capped client-side (§5's
  // token-minimization constraint: decision context gets a bounded
  // slice, never the full memory table). One query for the whole
  // world rather than one per character — fine at alpha's 20-
  // character scale; revisit with a per-character indexed/limited
  // query if the memory table grows large enough for this to matter.
  const MAX_RECENT_MEMORIES_PER_CHARACTER = 5;
  const RECENT_MEMORY_QUERY_CAP = 1000;
  const recentMemoryRows = await db
    .select({ characterId: memories.characterId, content: memories.content })
    .from(memories)
    .orderBy(desc(memories.createdAt))
    .limit(RECENT_MEMORY_QUERY_CAP);

  const recentMemoriesByCharacterId = new Map<string, string[]>();
  for (const row of recentMemoryRows) {
    const list = recentMemoriesByCharacterId.get(row.characterId) ?? [];
    // recentMemoryRows is globally sorted newest-first, so each
    // character's subsequence, taken in encounter order, is already
    // that character's own newest-first list.
    if (list.length < MAX_RECENT_MEMORIES_PER_CHARACTER) {
      list.push(row.content);
      recentMemoriesByCharacterId.set(row.characterId, list);
    }
  }

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

      const visibleCharacters: VisibleCharacter[] = (
        characterIdsByLocationId.get(currentState.locationId) ?? []
      )
        .filter((id) => id !== char.id)
        .map((id) => ({ characterId: id, name: characterNameById.get(id) ?? 'someone' }));

      const activeConversations = activeConversationsByCharacterId.get(char.id) ?? [];

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
        recentMemories: recentMemoriesByCharacterId.get(char.id) ?? [],
        availableActions: ['IDLE', 'MOVE', 'WORK', 'START_CONVERSATION', 'CONTINUE_CONVERSATION'],
        visibleCharacters,
        activeConversations,
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
        charactersAtSameLocation: visibleCharacters.map((v) => v.characterId),
        activeConversationIds: activeConversations.map((c) => c.conversationId),
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
        await executeAction({
          db,
          provider,
          actor: {
            id: char.id,
            name: char.name,
            personalityTraits: ctx.personalityTraits,
          },
          decision,
          state: currentState,
          locations: locationsBySlug,
          cycleId,
          gameDayRealSeconds: config.gameDayRealSeconds,
          characterNameById,
          conversationInfoById,
          conversationMessageCounts,
        });
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

// A conversation caps at this many total messages before the engine
// ends it deterministically — bounds token spend (every message is a
// generateDialogue call) and gives conversations a natural close
// instead of running until a character wanders off mid-tick.
const MAX_CONVERSATION_MESSAGES = 6;

interface ExecuteActionParams {
  db: Db;
  provider: AgentModelProvider;
  actor: { id: string; name: string; personalityTraits: Array<{ trait: string; weight: number }> };
  decision: AgentDecision;
  state: { locationId: string; status: string };
  locations: LocationInfo[];
  cycleId: string;
  gameDayRealSeconds: number;
  characterNameById: Map<string, string>;
  conversationInfoById: Map<string, { participantIds: string[]; locationId: string | null }>;
  conversationMessageCounts: Map<string, number>;
}

async function executeAction(params: ExecuteActionParams): Promise<void> {
  const {
    db,
    provider,
    actor,
    decision,
    state,
    locations,
    cycleId,
    gameDayRealSeconds,
    characterNameById,
    conversationInfoById,
    conversationMessageCounts,
  } = params;
  const characterId = actor.id;

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

    case 'START_CONVERSATION': {
      const targetCharacterId = decision.target_id;
      if (!targetCharacterId) return;
      const targetName = characterNameById.get(targetCharacterId) ?? 'someone';

      const [conversationRow] = await db
        .insert(conversations)
        .values({
          locationId: state.locationId,
          participantIds: [characterId, targetCharacterId],
          visibility: 'public',
        })
        .returning({ id: conversations.id });

      const relationship = await getRelationship(db, characterId, targetCharacterId);
      const topic =
        typeof decision.parameters?.topic === 'string' ? decision.parameters.topic : decision.intent;

      const dialogue = await provider.generateDialogue({
        characterId,
        name: actor.name,
        personalityTraits: actor.personalityTraits,
        targetCharacterId,
        targetName,
        relationship: { ...relationship },
        topic,
        gameCycleId: cycleId,
      });

      await db.insert(conversationMessages).values({
        conversationId: conversationRow.id,
        characterId,
        content: dialogue.message,
      });
      conversationMessageCounts.set(conversationRow.id, 1);

      await db.insert(gameEvents).values({
        type: 'CONVERSATION_STARTED',
        actorCharacterId: characterId,
        targetCharacterId,
        locationId: state.locationId,
        payload: {
          conversation_id: conversationRow.id,
          message: dialogue.message,
          emotional_tone: dialogue.emotionalTone,
          topic,
        },
        importance: 0.3,
        createdAt: new Date(),
      });

      // Deterministic engine effect, not the LLM's to decide (§5) — the
      // model chose to talk; how much that moves the relationship needle
      // comes from relationship-engine.ts's fixed effect table.
      const effect = await applyRelationshipEffect(
        db,
        characterId,
        targetCharacterId,
        'CONVERSATION_STARTED'
      );
      await db.insert(gameEvents).values({
        type: 'RELATIONSHIP_CHANGED',
        actorCharacterId: characterId,
        targetCharacterId,
        locationId: state.locationId,
        payload: { effect: 'CONVERSATION_STARTED', before: effect.before, after: effect.after },
        importance: 0.15,
        createdAt: new Date(),
      });
      break;
    }

    case 'CONTINUE_CONVERSATION': {
      const conversationId = decision.target_id;
      if (!conversationId) return;

      // Re-check against the batch-loaded map even though the validator
      // already confirmed this conversation is open for this character —
      // never trust that upstream state can't have shifted; a missing
      // entry here means write nothing rather than guess.
      const info = conversationInfoById.get(conversationId);
      if (!info) return;
      const targetCharacterId = info.participantIds.find((id) => id !== characterId);
      if (!targetCharacterId) return;
      const targetName = characterNameById.get(targetCharacterId) ?? 'someone';
      const eventLocationId = info.locationId ?? state.locationId;

      const relationship = await getRelationship(db, characterId, targetCharacterId);

      const dialogue = await provider.generateDialogue({
        characterId,
        name: actor.name,
        personalityTraits: actor.personalityTraits,
        targetCharacterId,
        targetName,
        relationship: { ...relationship },
        topic: decision.intent,
        gameCycleId: cycleId,
      });

      await db.insert(conversationMessages).values({
        conversationId,
        characterId,
        content: dialogue.message,
      });

      const messageCount = (conversationMessageCounts.get(conversationId) ?? 0) + 1;
      conversationMessageCounts.set(conversationId, messageCount);

      await db.insert(gameEvents).values({
        type: 'CONVERSATION_MESSAGE',
        actorCharacterId: characterId,
        targetCharacterId,
        locationId: eventLocationId,
        payload: {
          conversation_id: conversationId,
          message: dialogue.message,
          emotional_tone: dialogue.emotionalTone,
        },
        importance: 0.15,
        createdAt: new Date(),
      });

      const effect = await applyRelationshipEffect(
        db,
        characterId,
        targetCharacterId,
        'CONVERSATION_CONTINUED'
      );
      await db.insert(gameEvents).values({
        type: 'RELATIONSHIP_CHANGED',
        actorCharacterId: characterId,
        targetCharacterId,
        locationId: eventLocationId,
        payload: { effect: 'CONVERSATION_CONTINUED', before: effect.before, after: effect.after },
        importance: 0.1,
        createdAt: new Date(),
      });

      if (messageCount >= MAX_CONVERSATION_MESSAGES) {
        await db
          .update(conversations)
          .set({ endedAt: new Date() })
          .where(eq(conversations.id, conversationId));

        await db.insert(gameEvents).values({
          type: 'CONVERSATION_ENDED',
          actorCharacterId: characterId,
          targetCharacterId,
          locationId: eventLocationId,
          payload: { conversation_id: conversationId, reason: 'message_cap_reached' },
          importance: 0.1,
          createdAt: new Date(),
        });
      }
      break;
    }
  }
}
