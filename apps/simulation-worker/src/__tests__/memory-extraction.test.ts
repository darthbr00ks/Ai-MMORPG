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
