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
  let noWalletCharacterId: string;

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
    await db.insert(schema.wallets).values({ characterId: knownCharacterId, balanceCents: 12_345 });

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

    // Standing at a KNOWN location (survives the filter) but deliberately
    // given no wallet row — the LEFT JOIN fallback path a real character
    // could hit between being created and their wallet row landing.
    const [noWalletCharacter] = await db
      .insert(schema.characters)
      .values({
        name: 'World Map Test — No Wallet Resident',
        age: 30,
        background: 'Stands at a known location but has no wallet row.',
        personalityTraits: [],
        skills: [],
        ambitions: [],
        archetype: 'peacekeeper',
      })
      .returning({ id: schema.characters.id });
    noWalletCharacterId = noWalletCharacter.id;
    await db.insert(schema.characterState).values({ characterId: noWalletCharacterId, locationId: knownLocationId });
  });

  afterAll(async () => {
    await db.delete(schema.wallets).where(eq(schema.wallets.characterId, knownCharacterId));
    await db.delete(schema.characterState).where(eq(schema.characterState.characterId, knownCharacterId));
    await db.delete(schema.characterState).where(eq(schema.characterState.characterId, orphanCharacterId));
    await db.delete(schema.characterState).where(eq(schema.characterState.characterId, noWalletCharacterId));
    await db.delete(schema.characters).where(eq(schema.characters.id, knownCharacterId));
    await db.delete(schema.characters).where(eq(schema.characters.id, orphanCharacterId));
    await db.delete(schema.characters).where(eq(schema.characters.id, noWalletCharacterId));
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
    expect(knownCharacter.locationName).toBe('Town Square');
    expect(knownCharacter.status).toBe('idle');
    expect(knownCharacter.age).toBe(30);
    expect(knownCharacter.travelDestinationId).toBeNull();
    expect(knownCharacter.travelEta).toBeNull();
    expect(body.locations.some((loc: { id: string }) => loc.id === knownLocationId)).toBe(true);
  });

  it("exposes the character's real wallet balance for WorldMap's wealth badge", async () => {
    const { GET } = await import('../route.js');
    const res = await GET();
    const body = await res.json();

    const knownCharacter = body.characters.find((c: { id: string }) => c.id === knownCharacterId);
    expect(knownCharacter.walletCents).toBe(12_345);
  });

  it('defaults walletCents to 0 for a character with no wallet row, rather than null or crashing', async () => {
    const { GET } = await import('../route.js');
    const res = await GET();
    expect(res.status).toBe(200); // the LEFT JOIN must not throw on a missing wallet row
    const body = await res.json();

    const noWalletCharacter = body.characters.find((c: { id: string }) => c.id === noWalletCharacterId);
    expect(noWalletCharacter).toBeDefined();
    expect(noWalletCharacter.walletCents).toBe(0);
  });
});
