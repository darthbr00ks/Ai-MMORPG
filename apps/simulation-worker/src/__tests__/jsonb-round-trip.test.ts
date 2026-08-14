/**
 * Regression test for the jsonb double-encoding bug (§9 of the
 * running task list; see packages/database/src/custom-jsonb.ts and
 * docs/architecture.md's "Known issue" section for the full
 * root-cause writeup). Confirms two things a plain drizzle
 * select-and-compare can't: that the value written through this
 * app's own code path (an INSERT via drizzle) is stored as a REAL
 * jsonb object/array at the database level — checked with raw SQL's
 * `jsonb_typeof()`, which is exactly what silently returned 'string'
 * for every jsonb column before this fix — and that Postgres's own
 * `->>` operator (what any raw-SQL consumer, admin query, or external
 * tool would use) can read a field out of it directly.
 *
 * Runs against a real Postgres; skipped without DATABASE_URL like the
 * rest of this suite.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@ai-world/database';

const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('jsonb columns store real objects/arrays, not double-encoded strings', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let characterId: string;
  let eventId: string;

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    const [character] = await db
      .insert(schema.characters)
      .values({
        name: 'Jsonb Round Trip Test Character',
        age: 30,
        background: 'A character created to test jsonb round-tripping.',
        personalityTraits: [{ trait: 'honest', weight: 0.9 }],
        skills: ['testing'],
        ambitions: ['prove the bug is fixed'],
        archetype: 'wealth-seeker',
      })
      .returning({ id: schema.characters.id });
    characterId = character.id;

    const [event] = await db
      .insert(schema.gameEvents)
      .values({
        type: 'CHARACTER_IDLE',
        actorCharacterId: characterId,
        payload: { intent: 'testing', goal: 'verify jsonb storage', nested: { ok: true } },
        importance: 0.1,
      })
      .returning({ id: schema.gameEvents.id });
    eventId = event.id;
  });

  afterAll(async () => {
    await db.delete(schema.gameEvents).where(eq(schema.gameEvents.id, eventId));
    await db.delete(schema.characters).where(eq(schema.characters.id, characterId));
    await client.end();
  });

  it('stores an array-typed column as a real jsonb array', async () => {
    const [row] = await db
      .select({ typeofCol: sql<string>`jsonb_typeof(${schema.characters.personalityTraits})` })
      .from(schema.characters)
      .where(eq(schema.characters.id, characterId));
    expect(row.typeofCol).toBe('array');
  });

  it('stores an object-typed column as a real jsonb object, readable with ->>', async () => {
    const [row] = await db
      .select({
        typeofCol: sql<string>`jsonb_typeof(${schema.gameEvents.payload})`,
        intent: sql<string>`${schema.gameEvents.payload} ->> 'intent'`,
        nestedOk: sql<string>`${schema.gameEvents.payload} -> 'nested' ->> 'ok'`,
      })
      .from(schema.gameEvents)
      .where(eq(schema.gameEvents.id, eventId));
    expect(row.typeofCol).toBe('object');
    expect(row.intent).toBe('testing');
    expect(row.nestedOk).toBe('true');
  });

  it('still round-trips correctly through drizzle\'s own select (application-level read path)', async () => {
    const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, characterId));
    expect(char.personalityTraits).toEqual([{ trait: 'honest', weight: 0.9 }]);
    expect(char.skills).toEqual(['testing']);

    const [event] = await db.select().from(schema.gameEvents).where(eq(schema.gameEvents.id, eventId));
    expect(event.payload).toEqual({ intent: 'testing', goal: 'verify jsonb storage', nested: { ok: true } });
  });

  it('self-heals reads of a not-yet-migrated (still double-encoded) row', async () => {
    // Reproduces exactly what the OLD, pre-fix code path used to
    // store: a JSON.stringify'd value handed to postgres.js for a
    // jsonb column gets serialized a SECOND time by postgres.js's own
    // jsonb serializer (confirmed empirically during the original
    // root-cause investigation — this is not a synthetic shortcut,
    // it's the real bug reproduced on demand). Simulates a row this
    // fix's write path never touched — e.g. one from before
    // pnpm db:fix-jsonb-double-encoding was ever run.
    const legacyValue = { legacy: true, value: 42 };
    await client`update game_events set payload = ${JSON.stringify(legacyValue)} where id = ${eventId}`;

    const [rawRow] = await client<{ typeofCol: string }[]>`
      select jsonb_typeof(payload) as "typeofCol" from game_events where id = ${eventId}
    `;
    expect(rawRow.typeofCol).toBe('string'); // confirms the row really is double-encoded

    const [event] = await db.select().from(schema.gameEvents).where(eq(schema.gameEvents.id, eventId));
    expect(event.payload).toEqual(legacyValue); // but drizzle's own read path still recovers it correctly
  });
});
