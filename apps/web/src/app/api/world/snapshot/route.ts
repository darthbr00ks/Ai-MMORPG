import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { schema } from '@ai-world/database';
import { eq } from 'drizzle-orm';
import { WORLD_LOCATION_SLUGS } from '@/lib/world-scene-layout';

export const dynamic = 'force-dynamic';

export interface WorldSnapshotLocation {
  id: string;
  slug: string;
  name: string;
  connections: string[];
}

export interface WorldSnapshotCharacter {
  id: string;
  name: string;
  age: number;
  archetype: string;
  locationId: string;
  locationName: string;
  status: 'idle' | 'working' | 'traveling' | 'conversing' | 'sleeping' | 'planning';
  factionId: string | null;
  factionColor: string | null;
  factionName: string | null;
  factionRank: 'leader' | 'commander' | 'captain' | 'lieutenant' | 'member' | null;
  travelDestinationId: string | null;
  travelEta: string | null;
  // Cents, not a display string — WorldMap decides its own wealth-tell
  // threshold/formatting. 0 for a character whose wallet row hasn't
  // loaded (shouldn't happen — every seeded/created character gets
  // one — but never crash the snapshot over a display accent).
  walletCents: number;
}

export interface WorldSnapshot {
  locations: WorldSnapshotLocation[];
  characters: WorldSnapshotCharacter[];
}

/**
 * Authoritative world state for WorldMap's periodic poll (every
 * WorldMap.SNAPSHOT_POLL_MS) — who's where, right now. Kept separate
 * from the SSE event stream on purpose: events are a delta log, and a
 * client that reconstructed position purely from a dropped or
 * late-subscribed event stream could drift from the database forever.
 * This route is the self-healing correction for that; the event stream
 * (/api/events/stream, unchanged by this route) stays responsible only
 * for the transient effects layered on top — speech bubbles, travel
 * pulses — where a missed one just means one fewer animation, not a
 * stale world.
 *
 * Locations without a hand-placed WorldMap coordinate (LOCATION_LAYOUT)
 * are dropped here rather than sent with an undefined position — in
 * practice this is leftover *-test-*-slug fixture rows some integration
 * tests insert and never clean up, never something a spectator should
 * see on the map.
 */
type LocationRow = {
  id: string;
  slug: string;
  name: string;
  connections: unknown;
};

type CharacterRow = {
  id: string;
  name: string;
  age: number;
  archetype: string;
  locationId: string;
  locationName: string;
  status: WorldSnapshotCharacter['status'];
  factionId: string | null;
  factionRank: WorldSnapshotCharacter['factionRank'];
  factionColor: string | null;
  factionName: string | null;
  travelDestinationId: string | null;
  travelEta: Date | null;
  walletCents: number | null;
};

async function loadWorldSnapshot(): Promise<WorldSnapshot> {
  // Each query promise is explicitly typed before being handed to
  // Promise.all below — passing the two drizzle query builders inline
  // as a Promise.all([...]) array literal loses each one's inferred row
  // type under this repo's tsconfig (both widen to `any`); assigning
  // them to pre-typed variables first keeps the row types while still
  // letting Promise.all run both queries concurrently (drizzle query
  // builders are lazy — they don't hit the database until awaited/
  // `.then`'d, which is exactly what Promise.all does to both below).
  const locationRowsPromise: Promise<LocationRow[]> = getDb()
    .select({
      id: schema.locations.id,
      slug: schema.locations.slug,
      name: schema.locations.name,
      connections: schema.locations.connections,
    })
    .from(schema.locations);
  const characterRowsPromise: Promise<CharacterRow[]> = getDb()
    .select({
      id: schema.characters.id,
      name: schema.characters.name,
      age: schema.characters.age,
      archetype: schema.characters.archetype,
      locationId: schema.characterState.locationId,
      locationName: schema.locations.name,
      status: schema.characterState.status,
      factionId: schema.characterState.factionId,
      factionRank: schema.characterState.factionRank,
      factionColor: schema.factions.color,
      factionName: schema.factions.name,
      travelDestinationId: schema.characterState.travelDestinationId,
      travelEta: schema.characterState.travelEta,
      walletCents: schema.wallets.balanceCents,
    })
    .from(schema.characters)
    .innerJoin(schema.characterState, eq(schema.characters.id, schema.characterState.characterId))
    .innerJoin(schema.locations, eq(schema.characterState.locationId, schema.locations.id))
    .leftJoin(schema.factions, eq(schema.characterState.factionId, schema.factions.id))
    .leftJoin(schema.wallets, eq(schema.characters.id, schema.wallets.characterId));

  const [locationRows, characterRows] = await Promise.all([locationRowsPromise, characterRowsPromise]);

  const knownLocationRows = locationRows.filter((loc) => WORLD_LOCATION_SLUGS.includes(loc.slug));
  const knownLocationIds = new Set(knownLocationRows.map((loc) => loc.id));

  return {
    locations: knownLocationRows.map((loc) => ({
      id: loc.id,
      slug: loc.slug,
      name: loc.name,
      connections: (loc.connections as string[] | null) ?? [],
    })),
    characters: characterRows
      .filter((c) => knownLocationIds.has(c.locationId))
      .map((c) => ({
        id: c.id,
        name: c.name,
        age: c.age,
        archetype: c.archetype,
        locationId: c.locationId,
        locationName: c.locationName,
        status: c.status,
        factionId: c.factionId ?? null,
        factionColor: c.factionColor ?? null,
        factionName: c.factionName ?? null,
        factionRank: c.factionRank ?? null,
        travelDestinationId: c.travelDestinationId ?? null,
        travelEta: c.travelEta ? c.travelEta.toISOString() : null,
        walletCents: c.walletCents ?? 0,
      })),
  };
}

export async function GET() {
  try {
    const snapshot = await loadWorldSnapshot();
    return NextResponse.json(snapshot);
  } catch (err) {
    // Same rationale as /spectate's own getActiveCharacters: a DB
    // outage must return a distinguishable error, not a silently empty
    // (and therefore misleadingly "world has no one in it") snapshot.
    console.error('[world/snapshot] failed to load world state:', err);
    return NextResponse.json({ error: 'Failed to load world snapshot' }, { status: 503 });
  }
}
