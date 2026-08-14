import { type Db } from '@ai-world/database';
import { inventory } from '@ai-world/database';
import { and, eq } from 'drizzle-orm';

export interface InventoryMutationResult {
  success: boolean;
  reason?: string;
  newQuantity?: number;
}

/**
 * Add `quantity` of an item to a character's inventory, creating the
 * row on first contact. There's no unique constraint on
 * (characterId, itemId) at the DB level, so every mutation MUST go
 * through this lock-then-upsert path rather than a bare INSERT —
 * otherwise concurrent additions could create two rows for the same
 * character/item pair instead of one row with a summed quantity.
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

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(inventory)
      .where(and(eq(inventory.characterId, characterId), eq(inventory.itemId, itemId)))
      .for('update')
      .limit(1);

    if (existing) {
      const [updated] = await tx
        .update(inventory)
        .set({ quantity: existing.quantity + quantity })
        .where(eq(inventory.id, existing.id))
        .returning({ quantity: inventory.quantity });
      return { success: true, newQuantity: updated.quantity };
    }

    const [inserted] = await tx
      .insert(inventory)
      .values({ characterId, itemId, quantity })
      .returning({ quantity: inventory.quantity });
    return { success: true, newQuantity: inserted.quantity };
  });
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

    const [toRow] = await tx
      .select()
      .from(inventory)
      .where(and(eq(inventory.characterId, toCharacterId), eq(inventory.itemId, itemId)))
      .for('update')
      .limit(1);

    await tx
      .update(inventory)
      .set({ quantity: fromRow.quantity - quantity })
      .where(eq(inventory.id, fromRow.id));

    if (toRow) {
      await tx
        .update(inventory)
        .set({ quantity: toRow.quantity + quantity })
        .where(eq(inventory.id, toRow.id));
    } else {
      await tx.insert(inventory).values({ characterId: toCharacterId, itemId, quantity });
    }

    return { success: true };
  });
}
