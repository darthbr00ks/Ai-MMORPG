/**
 * End-to-end integration test for the Phase-1 acceptance path (§54/§57
 * of the build plan):
 *
 *   directive submitted -> worker tick -> AI decision -> validated
 *   action -> GameEvent written -> world state changed
 *
 * Runs against a REAL Postgres — this is deliberately not mocked at the
 * DB layer, only the AI provider is mocked (MockProvider, zero cost).
 *
 * Requires DATABASE_URL to point at a reachable, migrated Postgres
 * (`docker compose up -d && pnpm db:migrate` from the repo root). If
 * DATABASE_URL is unset the whole suite is skipped rather than failing
 * — see the note in the build-plan review about this environment not
 * having Docker/Postgres available to actually execute this file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, inArray } from 'drizzle-orm';
import { schema } from '@ai-world/database';
import { MockProvider } from '@ai-world/ai';
import { processTick } from '../tick-processor.js';

const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('processTick — full directive-to-event path', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let characterId: string;
  let locationId: string;
  let userId: string;

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    const [location] = await db
      .insert(schema.locations)
      .values({
        name: 'Test Square',
        slug: `test-square-${Date.now()}`,
        description: 'A test location',
        connections: [],
      })
      .returning({ id: schema.locations.id });
    locationId = location.id;

    const [user] = await db
      .insert(schema.users)
      .values({ email: `test-${Date.now()}@example.com` })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [character] = await db
      .insert(schema.characters)
      .values({
        name: 'Test Character',
        age: 30,
        background: 'A character created for integration testing.',
        personalityTraits: [{ trait: 'cautious', weight: 0.8 }],
        skills: [],
        ambitions: ['earn wealth'],
        archetype: 'wealth-seeker',
      })
      .returning({ id: schema.characters.id });
    characterId = character.id;

    await db.insert(schema.characterOwnership).values({
      characterId,
      userId,
      active: true,
    });

    await db.insert(schema.characterState).values({
      characterId,
      locationId,
      health: 100,
      fatigue: 0,
      status: 'idle',
    });

    await db.insert(schema.wallets).values({ characterId, balanceCents: 1000 });

    // The directive itself, matching what the /api/directives route would write
    await db.insert(schema.directives).values({
      characterId,
      userId,
      text: 'Become wealthy through honest work.',
      gameDay: 0,
      active: true,
    });
  });

  afterAll(async () => {
    // Best-effort cleanup — leaves nothing behind for repeat runs.
    // Order matters: FK constraints require ai_usage/agentActions/
    // gameEvents/agentDecisions gone before the character itself. Scope
    // agentActions to this character's own decisions only — never
    // truncate the whole table, it may hold other tests'/seed data.
    const ownDecisions = await db
      .select({ id: schema.agentDecisions.id })
      .from(schema.agentDecisions)
      .where(eq(schema.agentDecisions.characterId, characterId));
    const decisionIds = ownDecisions.map((d) => d.id);

    await db.delete(schema.gameEvents).where(eq(schema.gameEvents.actorCharacterId, characterId));
    await db.delete(schema.aiUsage).where(eq(schema.aiUsage.characterId, characterId));
    if (decisionIds.length > 0) {
      await db.delete(schema.agentActions).where(inArray(schema.agentActions.decisionId, decisionIds));
    }
    // A WORK action credits the wallet, which writes a ledger row with
    // this character as the recipient — must go before the wallet/character.
    await db.delete(schema.transactions).where(eq(schema.transactions.toCharacterId, characterId));
    await db.delete(schema.agentDecisions).where(eq(schema.agentDecisions.characterId, characterId));
    await db.delete(schema.directives).where(eq(schema.directives.characterId, characterId));
    await db.delete(schema.wallets).where(eq(schema.wallets.characterId, characterId));
    await db.delete(schema.characterState).where(eq(schema.characterState.characterId, characterId));
    await db.delete(schema.characterOwnership).where(eq(schema.characterOwnership.characterId, characterId));
    await db.delete(schema.characters).where(eq(schema.characters.id, characterId));
    await db.delete(schema.locations).where(eq(schema.locations.id, locationId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await client.end();
  });

  it('produces at least one decision and one event for the character', async () => {
    const result = await processTick(
      db,
      new MockProvider(),
      {
        gameDayRealSeconds: 300,
        simulationTickSeconds: 10,
        dailyBudgetCents: 500,
        providerName: 'mock',
        modelName: 'mock',
      },
      new Date()
    );

    expect(result.processedCharacters).toBeGreaterThan(0);
    // processTick sweeps every character in the table, exactly as it
    // would in production alongside the seeded 20 — assert this test's
    // own character produced no error, not that the whole table is
    // error-free (unrelated rows aren't this test's concern).
    expect(result.errors.some((e) => e.includes(characterId))).toBe(false);

    const decisions = await db
      .select()
      .from(schema.agentDecisions)
      .where(eq(schema.agentDecisions.characterId, characterId));
    expect(decisions.length).toBeGreaterThanOrEqual(1);

    const actions = await db
      .select()
      .from(schema.agentActions)
      .where(eq(schema.agentActions.decisionId, decisions[0].id));
    expect(actions.length).toBe(1);
    expect(['valid', 'rejected', 'fallback']).toContain(actions[0].validationResult);

    // Every processed character writes a GameEvent one way or another
    // (CHARACTER_IDLE / CHARACTER_MOVED / MONEY_EARNED / ACTION_REJECTED).
    const events = await db
      .select()
      .from(schema.gameEvents)
      .where(eq(schema.gameEvents.actorCharacterId, characterId));
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('records ai_usage for the decision call', async () => {
    const usage = await db
      .select()
      .from(schema.aiUsage)
      .where(eq(schema.aiUsage.characterId, characterId));
    expect(usage.length).toBeGreaterThanOrEqual(1);
    expect(usage[0].purpose).toBe('decideAction');
  });
});
