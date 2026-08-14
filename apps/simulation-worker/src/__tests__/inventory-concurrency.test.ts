/**
 * Regression test for a real race found by code review:
 * addToInventory/transferItem used to look up a character+item row
 * with `SELECT ... FOR UPDATE` and branch INSERT-vs-UPDATE based on
 * whether it existed — but a `SELECT ... FOR UPDATE` against a row
 * that doesn't exist yet locks nothing, so two concurrent first-time
 * additions of the same item to the same character could both
 * observe "no row" and both INSERT, producing two rows for the same
 * (characterId, itemId) pair. Fixed with a DB-level unique constraint
 * (migration 0006) plus `INSERT ... ON CONFLICT DO UPDATE`.
 *
 * This test proves the fix by actually racing two concurrent calls —
 * not just asserting the final state, which a sequential test
 * wouldn't expose the bug through at all.
 *
 * Runs against a real Postgres; skipped without DATABASE_URL like the
 * rest of this suite.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, and } from 'drizzle-orm';
import { schema } from '@ai-world/database';
import { addToInventory, transferItem } from '@ai-world/game-engine';

const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('inventory upsert concurrency', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let itemId: string;
  let characterId: string;
  let recipientId: string;
  let senderId: string;

  beforeAll(async () => {
    client = postgres(DB_URL!);
    db = drizzle(client, { schema });

    const [item] = await db
      .insert(schema.items)
      .values({ name: 'Inventory Concurrency Test Widget', category: 'test', basePriceCents: 10 })
      .returning({ id: schema.items.id });
    itemId = item.id;

    async function makeCharacter(name: string): Promise<string> {
      const [character] = await db
        .insert(schema.characters)
        .values({
          name,
          age: 30,
          background: 'A character created to test inventory upsert concurrency.',
          personalityTraits: [],
          skills: [],
          ambitions: [],
          archetype: 'wealth-seeker',
        })
        .returning({ id: schema.characters.id });
      return character.id;
    }

    characterId = await makeCharacter('Inventory Concurrency Test Character');
    recipientId = await makeCharacter('Inventory Concurrency Test Recipient');
    senderId = await makeCharacter('Inventory Concurrency Test Sender');
    await db.insert(schema.inventory).values({ characterId: senderId, itemId, quantity: 10 });
  });

  afterAll(async () => {
    const allIds = [characterId, recipientId, senderId];
    await db.delete(schema.inventory).where(and(eq(schema.inventory.itemId, itemId)));
    for (const id of allIds) {
      await db.delete(schema.characters).where(eq(schema.characters.id, id));
    }
    await db.delete(schema.items).where(eq(schema.items.id, itemId));
    await client.end();
  });

  it('addToInventory: two concurrent first-time additions sum into exactly one row', async () => {
    const [resultA, resultB] = await Promise.all([
      addToInventory(db, characterId, itemId, 3),
      addToInventory(db, characterId, itemId, 5),
    ]);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);

    const rows = await db
      .select()
      .from(schema.inventory)
      .where(and(eq(schema.inventory.characterId, characterId), eq(schema.inventory.itemId, itemId)));

    expect(rows.length).toBe(1);
    expect(rows[0].quantity).toBe(8);
  });

  it('transferItem: two concurrent first-time transfers to the same new recipient sum into exactly one row', async () => {
    const [resultA, resultB] = await Promise.all([
      transferItem(db, senderId, recipientId, itemId, 2),
      transferItem(db, senderId, recipientId, itemId, 3),
    ]);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);

    const recipientRows = await db
      .select()
      .from(schema.inventory)
      .where(and(eq(schema.inventory.characterId, recipientId), eq(schema.inventory.itemId, itemId)));
    expect(recipientRows.length).toBe(1);
    expect(recipientRows[0].quantity).toBe(5);

    const [senderRow] = await db
      .select()
      .from(schema.inventory)
      .where(and(eq(schema.inventory.characterId, senderId), eq(schema.inventory.itemId, itemId)));
    expect(senderRow.quantity).toBe(5); // started at 10, -2 -5
  });
});
