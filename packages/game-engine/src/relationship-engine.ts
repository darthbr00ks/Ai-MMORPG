import { and, eq } from 'drizzle-orm';
import { type Db, relationships } from '@ai-world/database';

/**
 * The six bounded dimensions tracked per relationship (§5 of the build
 * plan). All are clamped to [-100, 100] — nothing that touches a
 * relationship row, in this file or its callers, may write outside that
 * range.
 */
export interface RelationshipDimensions {
  trust: number;
  respect: number;
  affection: number;
  fear: number;
  hostility: number;
  familiarity: number;
}

export const RELATIONSHIP_DIMENSION_MIN = -100;
export const RELATIONSHIP_DIMENSION_MAX = 100;

export function clampRelationshipDimension(value: number): number {
  return Math.max(
    RELATIONSHIP_DIMENSION_MIN,
    Math.min(RELATIONSHIP_DIMENSION_MAX, value)
  );
}

export function defaultRelationshipDimensions(): RelationshipDimensions {
  return {
    trust: 0,
    respect: 0,
    affection: 0,
    fear: 0,
    hostility: 0,
    familiarity: 0,
  };
}

/**
 * A relationship between two characters is stored as one row, not two —
 * (A, B) and (B, A) must resolve to the same record. Every read and
 * write of the `relationships` table goes through this ordering so a
 * duplicate row for the same pair, sorted the other way, can never be
 * created (there is deliberately no unique constraint to fall back on —
 * the character-id UUIDs sort consistently, so a caller that always
 * canonicalizes never triggers one).
 */
export function canonicalizeCharacterPair(
  characterAId: string,
  characterBId: string
): [string, string] {
  return characterAId < characterBId
    ? [characterAId, characterBId]
    : [characterBId, characterAId];
}

/**
 * Closed registry of what a validated event is allowed to do to a
 * relationship's dimensions — deltas only, never absolute assignment.
 * This is what keeps §5's rule true in code, not just in a comment: the
 * LLM proposes an action (e.g. "start a conversation"); once the
 * deterministic engine validates and executes it, THIS table — not the
 * model — decides how much trust/affection/etc. moves, and by how much.
 * Extend deliberately as new interactions (trades, betrayals, gifts,
 * broken agreements) come online in later phases.
 */
const RELATIONSHIP_EFFECTS = {
  CONVERSATION_STARTED: { familiarity: 3, affection: 1 },
  CONVERSATION_CONTINUED: { familiarity: 2 },
} as const satisfies Record<string, Partial<RelationshipDimensions>>;

export type RelationshipEffectType = keyof typeof RELATIONSHIP_EFFECTS;

function applyDelta(
  current: RelationshipDimensions,
  delta: Partial<RelationshipDimensions>
): RelationshipDimensions {
  return {
    trust: clampRelationshipDimension(current.trust + (delta.trust ?? 0)),
    respect: clampRelationshipDimension(current.respect + (delta.respect ?? 0)),
    affection: clampRelationshipDimension(current.affection + (delta.affection ?? 0)),
    fear: clampRelationshipDimension(current.fear + (delta.fear ?? 0)),
    hostility: clampRelationshipDimension(current.hostility + (delta.hostility ?? 0)),
    familiarity: clampRelationshipDimension(current.familiarity + (delta.familiarity ?? 0)),
  };
}

export interface RelationshipEffectResult {
  characterAId: string;
  characterBId: string;
  before: RelationshipDimensions;
  after: RelationshipDimensions;
}

/**
 * Apply a registered relationship effect between two characters,
 * creating the row on first contact. Runs inside its own transaction
 * with a row lock, mirroring wallet.ts's atomicity pattern — two
 * characters interacting in rapid succession must never race into two
 * separate rows for the same pair or lose one side's update.
 */
export async function applyRelationshipEffect(
  db: Db,
  characterAId: string,
  characterBId: string,
  effectType: RelationshipEffectType
): Promise<RelationshipEffectResult> {
  const [lowId, highId] = canonicalizeCharacterPair(characterAId, characterBId);
  const delta = RELATIONSHIP_EFFECTS[effectType];

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(relationships)
      .where(
        and(eq(relationships.characterAId, lowId), eq(relationships.characterBId, highId))
      )
      .for('update')
      .limit(1);

    const before = existing ?? defaultRelationshipDimensions();
    const after = applyDelta(before, delta);

    if (existing) {
      await tx
        .update(relationships)
        .set({ ...after, updatedAt: new Date() })
        .where(eq(relationships.id, existing.id));
    } else {
      await tx.insert(relationships).values({
        characterAId: lowId,
        characterBId: highId,
        ...after,
      });
    }

    return { characterAId: lowId, characterBId: highId, before, after };
  });
}

/**
 * Read-only lookup used by decision context building — never mutates.
 * Returns defaults (all zero) rather than null for a pair that has
 * never interacted, since "no relationship yet" and "neutral
 * relationship" are the same thing from the character's point of view.
 */
export async function getRelationship(
  db: Db,
  characterAId: string,
  characterBId: string
): Promise<RelationshipDimensions> {
  const [lowId, highId] = canonicalizeCharacterPair(characterAId, characterBId);
  const [existing] = await db
    .select()
    .from(relationships)
    .where(
      and(eq(relationships.characterAId, lowId), eq(relationships.characterBId, highId))
    )
    .limit(1);
  return existing ?? defaultRelationshipDimensions();
}
