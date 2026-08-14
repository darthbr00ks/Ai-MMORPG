import { and, desc, eq, gte, lt } from 'drizzle-orm';
import type { Db } from '@ai-world/database';
import { aiUsage, characters, gameCycles, gameEvents, memories } from '@ai-world/database';
import type { AgentModelProvider } from '@ai-world/ai';
import { gameDayRealTimeWindow, describeGameEvent } from '@ai-world/shared';

// Bounds on what goes INTO an extractMemory call — §5's token-
// minimization constraint applies to memory extraction the same as
// decision context: never send a character's full day, send a capped,
// importance-ranked slice.
const MAX_EVENTS_PER_CHARACTER_PER_DAY = 30;
const MAX_EXISTING_MEMORIES_FOR_CONTEXT = 5;

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

  // One character's extraction is dominated by a single AI round-trip
  // (network latency, not CPU) — running the whole roster sequentially
  // means the day-boundary tick stalls for
  // roster_size * round_trip_latency before the next tick can start.
  // Every character's work here is independent (own events, own
  // memories, own aiUsage row), so Promise.all fans them all out at
  // once instead. Each character's whole body still runs inside its
  // own try/catch, exactly as the old sequential loop did, so one
  // character's failure can't take down another's — extractForCharacter
  // never rejects, it always resolves to a result describing what
  // happened.
  const perCharacterResults = await Promise.all(
    allCharacters.map((char) => extractForCharacter(char.id))
  );

  for (const result of perCharacterResults) {
    if (result.hadEvents) charactersProcessed++;
    memoriesWritten += result.memoriesWritten;
    if (result.error) errors.push(result.error);
  }

  return { charactersProcessed, memoriesWritten, errors };

  /**
   * One character's full extraction pass: load the day's events, skip
   * out early (zero cost) on a quiet day, call the provider, log
   * ai_usage, and write out every extracted memory. Mirrors the
   * sequential version's exact counting semantics even though it now
   * runs concurrently with every other character's call:
   *   - `hadEvents` (-> charactersProcessed) is decided the moment the
   *     day's events are known, independent of whether the AI call or
   *     the writes that follow it succeed.
   *   - `memoriesWritten` reflects partial progress — if the Nth memory
   *     insert throws, the first N-1 already written still count.
   */
  async function extractForCharacter(
    characterId: string
  ): Promise<{ hadEvents: boolean; memoriesWritten: number; error?: string }> {
    let hadEvents = false;
    let written = 0;
    try {
      const dayEvents = await db
        .select()
        .from(gameEvents)
        .where(
          and(
            eq(gameEvents.actorCharacterId, characterId),
            // gameDayRealTimeWindow is a half-open [start, end) window
            // — day N's `end` IS day N+1's `start`. Using `lt` (not
            // `lte`) here is what keeps a boundary-timestamp event
            // from matching both this day's query and the next day's,
            // which would extract the same event into two days' memories.
            gte(gameEvents.createdAt, dayStart),
            lt(gameEvents.createdAt, dayEnd)
          )
        )
        .orderBy(desc(gameEvents.importance))
        .limit(MAX_EVENTS_PER_CHARACTER_PER_DAY);

      // A quiet day (e.g. IDLE the whole time isn't even logged as
      // "quiet" — CHARACTER_IDLE events still count here) with truly
      // zero events costs zero tokens — skip the call entirely.
      if (dayEvents.length === 0) return { hadEvents: false, memoriesWritten: 0 };
      hadEvents = true;

      const existingMemoryRows = await db
        .select()
        .from(memories)
        .where(eq(memories.characterId, characterId))
        .orderBy(desc(memories.createdAt))
        .limit(MAX_EXISTING_MEMORIES_FOR_CONTEXT);

      const startMs = Date.now();
      const result = await provider.extractMemory({
        characterId,
        recentEvents: dayEvents.map(describeGameEvent),
        existingMemories: existingMemoryRows.map((m) => m.content),
        // Falls back to an empty string on the days that never got a
        // game_cycles row (see the module doc comment) — providers
        // only pass this through for logging/context, never branch on
        // it, so an empty string is a safe "no cycle id available"
        // signal rather than fabricating a fake UUID.
        gameCycleId: completedCycle?.id ?? '',
      });
      const latencyMs = Date.now() - startMs;

      // Usage is read from the result itself, not provider.getLastCallUsage()
      // — that method reflects one shared field on the provider
      // instance, which is unsafe to read once multiple characters'
      // calls are in flight concurrently (see provider.ts's doc
      // comment on getLastCallUsage). extractMemory returns its own
      // usage inline for exactly this reason.
      const usage = result.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostCents: 0,
      };

      await db.insert(aiUsage).values({
        characterId,
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
          characterId,
          kind: 'episodic',
          content: extracted.content,
          importance: extracted.importance,
          sourceEventId: representativeEventId,
          createdAt: new Date(),
        });
        written++;
      }

      return { hadEvents, memoriesWritten: written };
    } catch (err) {
      // Partial writes made before the failure still count — mirrors
      // the sequential version, where memoriesWritten was incremented
      // in the same per-memory loop a later statement could still throw
      // out of.
      return { hadEvents, memoriesWritten: written, error: `Character ${characterId}: ${String(err)}` };
    }
  }
}
