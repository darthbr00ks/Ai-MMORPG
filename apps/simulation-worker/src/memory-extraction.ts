import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { Db } from '@ai-world/database';
import { aiUsage, characters, gameCycles, gameEvents, memories } from '@ai-world/database';
import type { AgentModelProvider } from '@ai-world/ai';
import { gameDayRealTimeWindow } from '@ai-world/shared';

// Bounds on what goes INTO an extractMemory call — §5's token-
// minimization constraint applies to memory extraction the same as
// decision context: never send a character's full day, send a capped,
// importance-ranked slice.
const MAX_EVENTS_PER_CHARACTER_PER_DAY = 30;
const MAX_EXISTING_MEMORIES_FOR_CONTEXT = 5;

/**
 * Turns a raw GameEvent into the one-line, human-readable form
 * extractMemory (and eventually a human-facing daily report) expects —
 * the model summarizes narrative, it never sees raw payload JSON.
 */
function describeEvent(event: { type: string; payload: unknown }): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'CHARACTER_MOVED':
      return `Moved to ${payload.to_location_name ?? payload.destination ?? 'a new location'}.`;
    case 'MONEY_EARNED':
      return `Earned ${payload.amount_cents ?? 0} cents working.`;
    case 'CONVERSATION_STARTED':
      return `Started a conversation: "${payload.message ?? ''}"`;
    case 'CONVERSATION_MESSAGE':
      return `Said: "${payload.message ?? ''}"`;
    case 'CONVERSATION_ENDED':
      return 'A conversation came to an end.';
    case 'RELATIONSHIP_CHANGED':
      return `A relationship shifted (${payload.effect ?? 'an interaction'}).`;
    case 'ACTION_REJECTED':
      return `Tried something that didn't work out: ${payload.reason ?? 'unknown reason'}.`;
    case 'CHARACTER_IDLE':
      return 'Rested and observed the world.';
    default:
      return event.type.replace(/_/g, ' ').toLowerCase();
  }
}

export interface DailyMemoryExtractionResult {
  charactersProcessed: number;
  memoriesWritten: number;
  errors: string[];
}

/**
 * Extracts and stores episodic memories for every character, once per
 * completed game day — NOT once per tick (§5/§8: "periodic long-term
 * summary, scheduled job, not per-decision cost"). A character with a
 * quiet day (zero events) costs nothing, same containment principle as
 * "most ticks touch zero tokens" for decideAction.
 *
 * Call this exactly once, right after a NEW game_cycles row is created
 * for the day that just started — that's the natural once-per-day
 * hook, and `completedDayNumber` should be the day that just ended
 * (the new cycle's dayNumber minus one).
 *
 * The day's time window is computed directly from the world epoch
 * (`gameDayRealTimeWindow`), NOT read off a `game_cycles` row for that
 * day — a cycle row is only created lazily, the first time some tick
 * happens to observe that day number. In dev especially (a short
 * GAME_DAY_REAL_SECONDS combined with the worker restarting for any
 * reason) it's entirely possible for a day to complete without a
 * single tick ever landing inside it, in which case no row is ever
 * created for it and a lookup-based window would silently and
 * permanently skip that day's memories. Computing the window
 * arithmetically instead means extraction only depends on the world
 * epoch, which is always available.
 */
export async function extractDailyMemories(
  db: Db,
  provider: AgentModelProvider,
  completedDayNumber: number,
  providerName: string,
  modelName: string,
  cycleStartedAt: Date,
  gameDayRealSeconds: number
): Promise<DailyMemoryExtractionResult> {
  const errors: string[] = [];
  let memoriesWritten = 0;
  let charactersProcessed = 0;

  // Day -1 (or earlier) never happened — nothing to summarize, not an
  // error. Guards the very first tick of the world's day 0.
  if (completedDayNumber < 0) {
    return { charactersProcessed: 0, memoriesWritten: 0, errors };
  }

  const { start: dayStart, end: dayEnd } = gameDayRealTimeWindow(
    completedDayNumber,
    cycleStartedAt,
    gameDayRealSeconds
  );

  // Still look up that day's game_cycles row, purely to attribute
  // ai_usage/memories to a real gameCycleId when one happens to exist
  // — never as the source of the day's time window (see above).
  const [completedCycle] = await db
    .select()
    .from(gameCycles)
    .where(eq(gameCycles.dayNumber, completedDayNumber))
    .limit(1);

  const allCharacters = await db.select({ id: characters.id }).from(characters);

  for (const char of allCharacters) {
    try {
      const dayEvents = await db
        .select()
        .from(gameEvents)
        .where(
          and(
            eq(gameEvents.actorCharacterId, char.id),
            gte(gameEvents.createdAt, dayStart),
            lte(gameEvents.createdAt, dayEnd)
          )
        )
        .orderBy(desc(gameEvents.importance))
        .limit(MAX_EVENTS_PER_CHARACTER_PER_DAY);

      // A quiet day (e.g. IDLE the whole time isn't even logged as
      // "quiet" — CHARACTER_IDLE events still count here) with truly
      // zero events costs zero tokens — skip the call entirely.
      if (dayEvents.length === 0) continue;
      charactersProcessed++;

      const existingMemoryRows = await db
        .select()
        .from(memories)
        .where(eq(memories.characterId, char.id))
        .orderBy(desc(memories.createdAt))
        .limit(MAX_EXISTING_MEMORIES_FOR_CONTEXT);

      const startMs = Date.now();
      const result = await provider.extractMemory({
        characterId: char.id,
        recentEvents: dayEvents.map(describeEvent),
        existingMemories: existingMemoryRows.map((m) => m.content),
        // Falls back to an empty string on the days that never got a
        // game_cycles row (see the module doc comment) — providers
        // only pass this through for logging/context, never branch on
        // it, so an empty string is a safe "no cycle id available"
        // signal rather than fabricating a fake UUID.
        gameCycleId: completedCycle?.id ?? '',
      });
      const latencyMs = Date.now() - startMs;

      const usage = provider.getLastCallUsage?.() ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostCents: 0,
      };

      await db.insert(aiUsage).values({
        characterId: char.id,
        // Nullable in schema for exactly this case — no row exists
        // for a day that completed without a tick ever landing in it.
        gameCycleId: completedCycle?.id ?? null,
        provider: providerName,
        model: modelName,
        purpose: 'extractMemory',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        latencyMs,
        estimatedCostCents: usage.estimatedCostCents,
        success: true,
        createdAt: new Date(),
      });

      // The MemoryResult shape doesn't map each extracted memory back
      // to a specific source event, so every memory from this
      // character's batch is attributed to their single most
      // important event of the day (dayEvents is importance-sorted) —
      // a reasonable approximation, not a precise citation.
      const representativeEventId = dayEvents[0]?.id ?? null;

      for (const extracted of result.extractedMemories) {
        await db.insert(memories).values({
          characterId: char.id,
          kind: 'episodic',
          content: extracted.content,
          importance: extracted.importance,
          sourceEventId: representativeEventId,
          createdAt: new Date(),
        });
        memoriesWritten++;
      }
    } catch (err) {
      errors.push(`Character ${char.id}: ${String(err)}`);
      // Continue to the next character — one broken extraction never
      // blocks the rest of the day's memory pass, mirroring the tick
      // loop's own per-character isolation.
    }
  }

  return { charactersProcessed, memoriesWritten, errors };
}
