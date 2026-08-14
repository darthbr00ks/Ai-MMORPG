/**
 * Regression test for a real deadlock risk found by code review:
 * transferMoney's own doc comment claimed it "locks both rows in a
 * consistent order to avoid deadlocks," but the code locked
 * fromWallet then toWallet in CALLER-ARGUMENT order, not a
 * canonicalized order — consistent per call, not consistent ACROSS
 * calls. Two concurrent transfers going opposite directions between
 * the same two characters (A pays B, B pays A) would lock A-then-B in
 * one transaction and B-then-A in the other: a genuine Postgres
 * deadlock, with one transaction aborted. Fixed by sorting the lock
 * order by character id, independent of transfer direction — same
 * pattern relationship-engine.ts's canonicalizeCharacterPair already
 * uses for the identical reason.
 *
 * This test proves the fix by actually racing two opposite-direction
 * transfers — a sequential test wouldn't exercise the deadlock path
 * at all.
 *
 * Runs against a real Postgres; skipped without DATABASE_URL like the
 * rest of this suite.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { schema } from '@ai-world/database';
import { transferMoney } from '@ai-world/game-engine';

const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('transferMoney lock ordering', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let characterAId: string;
  let characterBId: string;

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    async function makeCharacter(name: string): Promise<string> {
      const [character] = await db
        .insert(schema.characters)
        .values({
          name,
          age: 30,
          background: 'A character created to test transferMoney lock ordering.',
          personalityTraits: [],
          skills: [],
          ambitions: [],
          archetype: 'wealth-seeker',
        })
        .returning({ id: schema.characters.id });
      return character.id;
    }

    characterAId = await makeCharacter('Wallet Concurrency Test A');
    characterBId = await makeCharacter('Wallet Concurrency Test B');
    await db.insert(schema.wallets).values([
      { characterId: characterAId, balanceCents: 1000 },
      { characterId: characterBId, balanceCents: 1000 },
    ]);
  });

  afterAll(async () => {
    const bothIds = [characterAId, characterBId];
    await db.delete(schema.transactions).where(eq(schema.transactions.fromCharacterId, characterAId));
    await db.delete(schema.transactions).where(eq(schema.transactions.fromCharacterId, characterBId));
    for (const id of bothIds) {
      await db.delete(schema.wallets).where(eq(schema.wallets.characterId, id));
      await db.delete(schema.characters).where(eq(schema.characters.id, id));
    }
    await client.end();
  });

  it('two concurrent opposite-direction transfers both complete without deadlocking', async () => {
    // Run this several times — a lock-ordering bug is a race, not a
    // guaranteed failure on every single execution.
    for (let i = 0; i < 5; i++) {
      const [resultAtoB, resultBtoA] = await Promise.all([
        transferMoney(db, characterAId, characterBId, 10, 'concurrency test A->B'),
        transferMoney(db, characterBId, characterAId, 10, 'concurrency test B->A'),
      ]);

      expect(resultAtoB.success).toBe(true);
      expect(resultBtoA.success).toBe(true);
    }

    // Equal opposing transfers net to zero — balances unchanged after
    // all 5 rounds.
    const [walletA] = await db.select().from(schema.wallets).where(eq(schema.wallets.characterId, characterAId));
    const [walletB] = await db.select().from(schema.wallets).where(eq(schema.wallets.characterId, characterBId));
    expect(walletA.balanceCents).toBe(1000);
    expect(walletB.balanceCents).toBe(1000);
  });
});
