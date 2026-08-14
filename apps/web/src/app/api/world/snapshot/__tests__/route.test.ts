/**
 * The dev database routinely accumulates leftover *-test-*-slug location
 * fixtures from other integration test suites that insert-and-never-clean-up
 * (see docs/architecture.md's World Map section — this was found while
 * building WorldMap.tsx against a real, long-running dev DB). Those rows
 * have no entry in LOCATION_LAYOUT and must never reach a spectator's
 * browser: no coordinate to render them at, and no reason a test fixture
 * should show up as a place in New Concord. This guards that filtering —
 * both for the orphan location itself and for any character the fixture
 * left standing there.
 *
 * Requires DATABASE_URL to point at a reachable, migrated, seeded
 * Postgres (this route only has anything to filter against seeded
 * locations like "town-square") — skipped otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from '@ai-world/database';
import { eq } from 'drizzle-orm';

const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('GET /api/world/snapshot — unknown-layout location filtering', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let knownLocationId: string;
  let orphanLocationId: string;
  let knownCharacterId: string;
  let orphanCharacterId: string;

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    const [townSquare] = await db
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(eq(schema.locations.slug, 'town-square'));
    if (!townSquare) {
      throw new Error(
        'GET /api/world/snapshot test requires a seeded "town-square" location. Run pnpm db:seed against DATABASE_URL before running this test.'
      );
    }
    knownLocationId = townSquare.id;

    const [orphanLocation] = await db
      .insert(schema.locations)
      .values({
        name: 'Orphan Test Fixture Square',
        slug: `orphan-test-square-${Date.now()}`,
        description: 'A location with no WorldMap coordinate — must never reach a spectator.',
        connections: [],
      })
      .returning({ id: schema.locations.id });
    orphanLocationId = orphanLocation.id;

    const [knownCharacter] = await db
      .insert(schema.characters)
      .values({
        name: 'World Map Test — Town Square Resident',
        age: 30,
        background: 'Stands at a location WorldMap knows how to draw.',
        personalityTraits: [],
        skills: [],
        ambitions: [],
        archetype: 'peacekeeper',
      })
      .returning({ id: schema.characters.id });
    knownCharacterId = knownCharacter.id;
    await db.insert(schema.characterState).values({ characterId: knownCharacterId, locationId: knownLocationId });

    const [orphanCharacter] = await db
      .insert(schema.characters)
      .values({
        name: 'World Map Test — Orphan Fixture Resident',
        age: 30,
        background: 'Stands at a location WorldMap has no coordinate for.',
        personalityTraits: [],
        skills: [],
        ambitions: [],
        archetype: 'peacekeeper',
      })
      .returning({ id: schema.characters.id });
    orphanCharacterId = orphanCharacter.id;
    await db.insert(schema.characterState).values({ characterId: orphanCharacterId, locationId: orphanLocationId });
  });

  afterAll(async () => {
    await db.delete(schema.characterState).where(eq(schema.characterState.characterId, knownCharacterId));
    await db.delete(schema.characterState).where(eq(schema.characterState.characterId, orphanCharacterId));
    await db.delete(schema.characters).where(eq(schema.characters.id, knownCharacterId));
    await db.delete(schema.characters).where(eq(schema.characters.id, orphanCharacterId));
    await db.delete(schema.locations).where(eq(schema.locations.id, orphanLocationId));
    await client.end();
  });

  it('excludes the orphan location and drops any character standing there', async () => {
    const { GET } = await import('../route.js');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.locations.some((loc: { id: string }) => loc.id === orphanLocationId)).toBe(false);
    expect(body.characters.some((c: { id: string }) => c.id === orphanCharacterId)).toBe(false);
  });

  it('still includes a character standing at a location WorldMap can render', async () => {
    const { GET } = await import('../route.js');
    const res = await GET();
    const body = await res.json();

    const knownCharacter = body.characters.find((c: { id: string }) => c.id === knownCharacterId);
    expect(knownCharacter).toBeDefined();
    expect(knownCharacter.locationId).toBe(knownLocationId);
    expect(knownCharacter.status).toBe('idle');
    expect(body.locations.some((loc: { id: string }) => loc.id === knownLocationId)).toBe(true);
  });
});
