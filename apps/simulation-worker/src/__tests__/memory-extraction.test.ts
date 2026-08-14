/**
 * Integration test for Phase 11's daily memory extraction pass
 * (§5/§8 of the build plan — periodic, once per completed game day,
 * never per tick). Runs against a real Postgres; skipped without
 * DATABASE_URL like the rest of this suite.
 *
 * The fabricated day window is pinned to the year 2000 specifically so
 * it can never overlap real dev/test activity from any other
 * character — extractDailyMemories sweeps every character in the
 * table (same design as processTick), and a window anywhere near "now"
 * would pull in whatever seeded/dev activity happened to be running
 * alongside this test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { schema } from '@ai-world/database';
import { MockProvider } from '@ai-world/ai';
import { extractDailyMemories } from '../memory-extraction.js';

const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('extractDailyMemories', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let characterId: string;
  let cycleId: string;
  // Distinctive and far outside any real game day number this world
  // will ever reach, so it can't collide with actual gameplay data.
  const dayNumber = 987654;

  const dayStart = new Date('2000-01-01T00:00:00Z');
  const dayEnd = new Date('2000-01-02T00:00:00Z');
  const gameDayRealSeconds = 86400;
  // extractDailyMemories computes the day's window arithmetically from
  // a world epoch (gameDayRealTimeWindow), not from the game_cycles
  // row — back-solve the epoch so day `dayNumber` lands exactly on
  // [dayStart, dayEnd).
  const cycleStartedAt = new Date(dayStart.getTime() - dayNumber * gameDayRealSeconds * 1000);

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    const [character] = await db
      .insert(schema.characters)
      .values({
        name: 'Memory Test Character',
        age: 40,
        background: 'A character created to test daily memory extraction.',
        personalityTraits: [],
        skills: [],
        ambitions: [],
        archetype: 'wealth-seeker',
      })
      .returning({ id: schema.characters.id });
    characterId = character.id;

    const [cycle] = await db
      .insert(schema.gameCycles)
      .values({ dayNumber, startedAt: dayStart, endedAt: dayEnd })
      .returning({ id: schema.gameCycles.id });
    cycleId = cycle.id;

    await db.insert(schema.gameEvents).values([
      {
        type: 'MONEY_EARNED',
        actorCharacterId: characterId,
        payload: { amount_cents: 120 },
        importance: 0.3,
        createdAt: new Date(dayStart.getTime() + 1000),
      },
      {
        type: 'CONVERSATION_STARTED',
        actorCharacterId: characterId,
        payload: { message: 'Well met.' },
        importance: 0.3,
        createdAt: new Date(dayStart.getTime() + 2000),
      },
      // Exactly on the boundary — belongs to the NEXT day
      // (gameDayRealTimeWindow is half-open [start, end)), so this
      // must NOT be picked up by this day's extraction. Regression
      // coverage for a real off-by-one found by code review.
      // Importance is deliberately HIGHER than the two legitimate
      // events above: dayEvents is queried ORDER BY importance DESC
      // then capped, and MockProvider.extractMemory further slices to
      // the first 2 — a low-importance boundary event could slip in
      // without ever affecting which events end up in the memories
      // this test checks, silently defeating the assertion below.
      {
        type: 'CHARACTER_IDLE',
        actorCharacterId: characterId,
        payload: {},
        importance: 0.9,
        createdAt: dayEnd,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.memories).where(eq(schema.memories.characterId, characterId));
    await db.delete(schema.aiUsage).where(eq(schema.aiUsage.characterId, characterId));
    await db.delete(schema.gameEvents).where(eq(schema.gameEvents.actorCharacterId, characterId));
    await db.delete(schema.gameCycles).where(eq(schema.gameCycles.id, cycleId));
    await db.delete(schema.characters).where(eq(schema.characters.id, characterId));
    await client.end();
  });

  it('writes episodic memories and an ai_usage row for a character with events that day', async () => {
    const result = await extractDailyMemories(
      db,
      new MockProvider(),
      dayNumber,
      'mock',
      'mock',
      cycleStartedAt,
      gameDayRealSeconds
    );

    expect(result.errors.some((e) => e.includes(characterId))).toBe(false);
    expect(result.charactersProcessed).toBeGreaterThanOrEqual(1);

    const memoryRows = await db
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.characterId, characterId));
    expect(memoryRows.length).toBeGreaterThanOrEqual(1);
    expect(memoryRows[0].kind).toBe('episodic');
    expect(memoryRows[0].sourceEventId).not.toBeNull();

    // The boundary-timestamp CHARACTER_IDLE event (dayEnd, next day's
    // start) must never appear — proves the day window is genuinely
    // half-open, not off-by-one.
    const memoryContents = memoryRows.map((m) => m.content);
    expect(memoryContents.some((c) => c.includes('Rested and observed'))).toBe(false);

    const usageRows = await db
      .select()
      .from(schema.aiUsage)
      .where(eq(schema.aiUsage.characterId, characterId));
    expect(usageRows.length).toBe(1);
    expect(usageRows[0].purpose).toBe('extractMemory');
  });

  it('returns cleanly with zero writes for a day number with no recorded cycle', async () => {
    const result = await extractDailyMemories(
      db,
      new MockProvider(),
      -987654,
      'mock',
      'mock',
      cycleStartedAt,
      gameDayRealSeconds
    );
    expect(result).toEqual({ charactersProcessed: 0, memoriesWritten: 0, errors: [] });
  });
});

/**
 * Regression coverage for a hazard introduced by parallelizing this
 * module's per-character loop (§17 of the hardening pass): every
 * character's extractMemory call is now in flight concurrently against
 * one provider instance. AnthropicProvider tracks per-call usage as one
 * shared `lastUsage` field, so reading cost via provider.getLastCallUsage()
 * after each await — safe when calls are sequential — would race under
 * concurrency and could attribute one character's token cost to
 * another. The fix has extractMemory return usage inline on its result
 * instead (MemoryResult.usage); this test proves extractDailyMemories
 * actually uses that inline value by racing two characters through a
 * provider that resolves them in REVERSE call order (the second
 * character's call finishes first) and asserting each ends up with its
 * own distinct cost, not the other's.
 */
describe.skipIf(!DB_URL)('extractDailyMemories — concurrent per-character usage attribution', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let characterAId: string;
  let characterBId: string;
  const dayNumber = 987655;
  const dayStart = new Date('2000-02-01T00:00:00Z');
  const gameDayRealSeconds = 86400;
  const cycleStartedAt = new Date(dayStart.getTime() - dayNumber * gameDayRealSeconds * 1000);

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    async function makeCharacter(name: string): Promise<string> {
      const [character] = await db
        .insert(schema.characters)
        .values({
          name,
          age: 40,
          background: 'A character created to test concurrent usage attribution.',
          personalityTraits: [],
          skills: [],
          ambitions: [],
          archetype: 'wealth-seeker',
        })
        .returning({ id: schema.characters.id });
      return character.id;
    }

    characterAId = await makeCharacter('Usage Race Test A');
    characterBId = await makeCharacter('Usage Race Test B');

    await db.insert(schema.gameEvents).values([
      {
        type: 'MONEY_EARNED',
        actorCharacterId: characterAId,
        payload: {},
        importance: 0.5,
        createdAt: new Date(dayStart.getTime() + 1000),
      },
      {
        type: 'MONEY_EARNED',
        actorCharacterId: characterBId,
        payload: {},
        importance: 0.5,
        createdAt: new Date(dayStart.getTime() + 1000),
      },
    ]);
  });

  afterAll(async () => {
    const bothIds = [characterAId, characterBId];
    for (const id of bothIds) {
      await db.delete(schema.memories).where(eq(schema.memories.characterId, id));
      await db.delete(schema.aiUsage).where(eq(schema.aiUsage.characterId, id));
      await db.delete(schema.gameEvents).where(eq(schema.gameEvents.actorCharacterId, id));
      await db.delete(schema.characters).where(eq(schema.characters.id, id));
    }
    await client.end();
  });

  it("attributes each character's own cost even when the other's call resolves first", async () => {
    // A distinct, identifiable cost per character (10 vs 20 cents) —
    // if a shared-mutable-usage read ever regressed back in, these
    // would come out swapped or identical rather than matching up
    // 1:1 with the character that actually made the call.
    const costByCharacter: Record<string, number> = {
      [characterAId]: 10,
      [characterBId]: 20,
    };

    const racyProvider = {
      async extractMemory(ctx: { characterId: string; recentEvents: string[] }) {
        // Character A is made to resolve AFTER character B despite
        // being called first — exactly the interleaving that would
        // expose a shared-field race.
        const delayMs = ctx.characterId === characterAId ? 30 : 0;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return {
          extractedMemories: [{ content: `memory for ${ctx.characterId}`, importance: 0.5 }],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCostCents: costByCharacter[ctx.characterId],
          },
        };
      },
      // Deliberately NOT implementing getLastCallUsage — this test
      // exists specifically to prove extractDailyMemories no longer
      // depends on it for these calls.
    };

    const result = await extractDailyMemories(
      db,
      racyProvider as never,
      dayNumber,
      'mock',
      'mock',
      cycleStartedAt,
      gameDayRealSeconds
    );

    expect(result.errors).toEqual([]);
    expect(result.charactersProcessed).toBe(2);

    const usageA = await db.select().from(schema.aiUsage).where(eq(schema.aiUsage.characterId, characterAId));
    const usageB = await db.select().from(schema.aiUsage).where(eq(schema.aiUsage.characterId, characterBId));
    expect(usageA[0].estimatedCostCents).toBeCloseTo(10);
    expect(usageB[0].estimatedCostCents).toBeCloseTo(20);
  });
});
