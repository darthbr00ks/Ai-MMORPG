import { type Db } from '@ai-world/database';
import { inventory } from '@ai-world/database';
import { and, eq, sql } from 'drizzle-orm';

export interface InventoryMutationResult {
  success: boolean;
  reason?: string;
  newQuantity?: number;
}

/**
 * Add `quantity` of an item to a character's inventory, creating the
 * row on first contact. Uses a single atomic `INSERT ... ON CONFLICT
 * DO UPDATE` against the (characterId, itemId) unique constraint,
 * rather than "SELECT ... FOR UPDATE, then INSERT-or-UPDATE" — that
 * older pattern looked safe but wasn't: a `SELECT ... FOR UPDATE`
 * against a row that doesn't exist yet locks nothing, so two
 * concurrent first-time additions of the same item could both
 * observe "no existing row" and both INSERT, producing two rows for
 * the same character+item pair. The database-level unique constraint
 * plus ON CONFLICT closes that gap structurally instead of relying on
 * an application-level lock that only works once a row already
 * exists.
 */
export async function addToInventory(
  db: Db,
  characterId: string,
  itemId: string,
  quantity: number
): Promise<InventoryMutationResult> {
  if (quantity <= 0) {
    return { success: false, reason: 'Quantity must be positive' };
  }

  const [row] = await db
    .insert(inventory)
    .values({ characterId, itemId, quantity })
    .onConflictDoUpdate({
      target: [inventory.characterId, inventory.itemId],
      set: { quantity: sql`${inventory.quantity} + ${quantity}` },
    })
    .returning({ quantity: inventory.quantity });

  return { success: true, newQuantity: row.quantity };
}

/**
 * Remove `quantity` of an item from a character's inventory. Fails
 * closed — insufficient (or zero/missing-row) quantity is a rejected
 * mutation, never a negative or auto-created-negative row.
 */
export async function removeFromInventory(
  db: Db,
  characterId: string,
  itemId: string,
  quantity: number
): Promise<InventoryMutationResult> {
  if (quantity <= 0) {
    return { success: false, reason: 'Quantity must be positive' };
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(inventory)
      .where(and(eq(inventory.characterId, characterId), eq(inventory.itemId, itemId)))
      .for('update')
      .limit(1);

    if (!existing || existing.quantity < quantity) {
      return {
        success: false,
        reason: `Insufficient inventory: has ${existing?.quantity ?? 0}, needs ${quantity}`,
      };
    }

    const [updated] = await tx
      .update(inventory)
      .set({ quantity: existing.quantity - quantity })
      .where(eq(inventory.id, existing.id))
      .returning({ quantity: inventory.quantity });

    return { success: true, newQuantity: updated.quantity };
  });
}

export interface ItemTransferResult {
  success: boolean;
  reason?: string;
}

/**
 * Move `quantity` of an item from one character to another (GIVE_ITEM)
 * — atomically. Deliberately does NOT delegate to addToInventory/
 * removeFromInventory (each of which opens its own transaction): both
 * halves are validated — sender has enough, in the same lock — BEFORE
 * either row is written, exactly like wallet.ts's transferMoney. That
 * ordering is what keeps this safe; validating one half, writing it,
 * and only then validating the other half would leave the sender
 * debited with nothing credited if the second half ever gained a
 * failure mode (e.g. a future per-item inventory cap, per §6's "cap
 * production deliberately").
 */
export async function transferItem(
  db: Db,
  fromCharacterId: string,
  toCharacterId: string,
  itemId: string,
  quantity: number
): Promise<ItemTransferResult> {
  if (quantity <= 0) {
    return { success: false, reason: 'Quantity must be positive' };
  }
  if (fromCharacterId === toCharacterId) {
    return { success: false, reason: 'Cannot transfer an item to yourself' };
  }

  return db.transaction(async (tx) => {
    const [fromRow] = await tx
      .select()
      .from(inventory)
      .where(and(eq(inventory.characterId, fromCharacterId), eq(inventory.itemId, itemId)))
      .for('update')
      .limit(1);

    if (!fromRow || fromRow.quantity < quantity) {
      return {
        success: false,
        reason: `Insufficient inventory: has ${fromRow?.quantity ?? 0}, needs ${quantity}`,
      };
    }

    await tx
      .update(inventory)
      .set({ quantity: fromRow.quantity - quantity })
      .where(eq(inventory.id, fromRow.id));

    // The recipient's row may not exist yet — same "SELECT FOR UPDATE
    // locks nothing on a row that isn't there" gap addToInventory's
    // doc comment describes, so this uses the same ON CONFLICT upsert
    // rather than a SELECT-then-branch.
    await tx
      .insert(inventory)
      .values({ characterId: toCharacterId, itemId, quantity })
      .onConflictDoUpdate({
        target: [inventory.characterId, inventory.itemId],
        set: { quantity: sql`${inventory.quantity} + ${quantity}` },
      });

    return { success: true };
  });
}
