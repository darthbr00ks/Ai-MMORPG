import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { schema } from '@ai-world/database';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export interface DiplomacyFaction {
  id: string;
  name: string;
  color: string;
  icon: string;
  foundedGameDay: number;
  leaderId: string | null;
}

export interface DiplomacyCharacter {
  id: string;
  name: string;
  factionId: string | null;
  factionRank: 'leader' | 'commander' | 'captain' | 'lieutenant' | 'member' | null;
}

export interface DiplomacyRelationship {
  characterAId: string;
  characterBId: string;
  trust: number;
  respect: number;
  affection: number;
  hostility: number;
}

export interface DiplomacySnapshot {
  factions: DiplomacyFaction[];
  characters: DiplomacyCharacter[];
  relationships: DiplomacyRelationship[];
}

/**
 * Data endpoint for the Diplomacy View tab — returns all factions,
 * characters with their faction membership/rank, and pairwise
 * relationships (trust, respect, affection, hostility). The client uses
 * this to render faction-bubble clusters with colored relationship edges.
 *
 * Relationships are only included when at least one dimension is non-zero,
 * to keep the payload small.
 */
export async function GET() {
  try {
    const db = getDb();

    const [factionRows, characterRows, relationshipRows] = await Promise.all([
      db
        .select({
          id: schema.factions.id,
          name: schema.factions.name,
          color: schema.factions.color,
          icon: schema.factions.icon,
          foundedGameDay: schema.factions.foundedGameDay,
          leaderId: schema.factions.leaderId,
        })
        .from(schema.factions),

      db
        .select({
          id: schema.characters.id,
          name: schema.characters.name,
          factionId: schema.characterState.factionId,
          factionRank: schema.characterState.factionRank,
        })
        .from(schema.characters)
        .innerJoin(
          schema.characterState,
          eq(schema.characters.id, schema.characterState.characterId)
        ),

      db
        .select({
          characterAId: schema.relationships.characterAId,
          characterBId: schema.relationships.characterBId,
          trust: schema.relationships.trust,
          respect: schema.relationships.respect,
          affection: schema.relationships.affection,
          hostility: schema.relationships.hostility,
        })
        .from(schema.relationships),
    ]);

    // Cast through unknown: the select() projections match the interface shapes
    // exactly, but when workspace packages aren't compiled the inferred row
    // type degrades to `any`, causing TS7006 on callback parameters.
    const snapshot: DiplomacySnapshot = {
      factions: factionRows as unknown as DiplomacyFaction[],
      characters: characterRows as unknown as DiplomacyCharacter[],
      // Drop all-zero rows to reduce payload size.
      relationships: (relationshipRows as unknown as DiplomacyRelationship[]).filter(
        (r) => r.trust !== 0 || r.respect !== 0 || r.affection !== 0 || r.hostility !== 0
      ),
    };

    return NextResponse.json(snapshot);
  } catch (err) {
    console.error('[world/diplomacy] failed to load diplomacy state:', err);
    return NextResponse.json({ error: 'Failed to load diplomacy snapshot' }, { status: 503 });
  }
}
