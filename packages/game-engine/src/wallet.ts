import { type Db } from '@ai-world/database';
import { wallets, transactions } from '@ai-world/database';
import { eq } from 'drizzle-orm';

export interface TransferResult {
  success: boolean;
  reason?: string;
  newFromBalance?: number;
  newToBalance?: number;
}

/**
 * Transfer money atomically between two characters.
 * Uses SELECT FOR UPDATE to prevent concurrent double-spend.
 * Writes both balance update + ledger row in one transaction.
 */
export async function transferMoney(
  db: Db,
  fromCharacterId: string,
  toCharacterId: string,
  amountCents: number,
  reason: string
): Promise<TransferResult> {
  if (amountCents <= 0) {
    return { success: false, reason: 'Amount must be positive' };
  }
  if (fromCharacterId === toCharacterId) {
    return { success: false, reason: 'Cannot transfer to yourself' };
  }

  // Lock both rows in a CANONICAL order — sorted by id, independent of
  // which one is "from" and which is "to" — not caller-argument order.
  // Locking in argument order looks consistent per-call but isn't
  // consistent ACROSS calls: two concurrent transfers going opposite
  // directions between the same two characters (A pays B, B pays A)
  // would lock A-then-B in one transaction and B-then-A in the other,
  // a real deadlock one of them has to lose. Same rationale as
  // relationship-engine.ts's canonicalizeCharacterPair.
  const [lowId, highId] =
    fromCharacterId < toCharacterId ? [fromCharacterId, toCharacterId] : [toCharacterId, fromCharacterId];

  return db.transaction(async (tx) => {
    const [lowWallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.characterId, lowId))
      .for('update')
      .limit(1);
    const [highWallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.characterId, highId))
      .for('update')
      .limit(1);

    const fromWallet = fromCharacterId === lowId ? lowWallet : highWallet;
    const toWallet = toCharacterId === lowId ? lowWallet : highWallet;

    if (!fromWallet) {
      return { success: false, reason: `No wallet for character ${fromCharacterId}` };
    }
    if (fromWallet.balanceCents < amountCents) {
      return {
        success: false,
        reason: `Insufficient funds: has ${fromWallet.balanceCents}, needs ${amountCents}`,
      };
    }
    if (!toWallet) {
      return { success: false, reason: `No wallet for character ${toCharacterId}` };
    }

    const [updatedFrom] = await tx
      .update(wallets)
      .set({
        balanceCents: fromWallet.balanceCents - amountCents,
        updatedAt: new Date(),
      })
      .where(eq(wallets.characterId, fromCharacterId))
      .returning({ balanceCents: wallets.balanceCents });

    const [updatedTo] = await tx
      .update(wallets)
      .set({
        balanceCents: toWallet.balanceCents + amountCents,
        updatedAt: new Date(),
      })
      .where(eq(wallets.characterId, toCharacterId))
      .returning({ balanceCents: wallets.balanceCents });

    // Write ledger row in the same transaction — no balance change without a ledger row
    await tx.insert(transactions).values({
      fromCharacterId,
      toCharacterId,
      amountCents,
      reason,
      createdAt: new Date(),
    });

    return {
      success: true,
      newFromBalance: updatedFrom.balanceCents,
      newToBalance: updatedTo.balanceCents,
    };
  });
}

/**
 * Credit a character's wallet (e.g. wages, gifts).
 * Uses SELECT FOR UPDATE to prevent concurrent races.
 * Atomically writes balance + ledger in one transaction.
 */
export async function creditWallet(
  db: Db,
  characterId: string,
  amountCents: number,
  reason: string
): Promise<TransferResult> {
  if (amountCents <= 0) {
    return { success: false, reason: 'Amount must be positive' };
  }

  return db.transaction(async (tx) => {
    const [wallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.characterId, characterId))
      .for('update')
      .limit(1);

    if (!wallet) {
      return { success: false, reason: `No wallet for character ${characterId}` };
    }

    const [updated] = await tx
      .update(wallets)
      .set({
        balanceCents: wallet.balanceCents + amountCents,
        updatedAt: new Date(),
      })
      .where(eq(wallets.characterId, characterId))
      .returning({ balanceCents: wallets.balanceCents });

    await tx.insert(transactions).values({
      fromCharacterId: null,
      toCharacterId: characterId,
      amountCents,
      reason,
      createdAt: new Date(),
    });

    return { success: true, newToBalance: updated.balanceCents };
  });
}

/**
 * Debit a character's wallet for money that leaves the game entirely
 * (e.g. paying the NPC market for BUY_ITEM) rather than moving to
 * another character's wallet — the mirror of creditWallet's "money
 * materializing" (wages), recorded the same way: a ledger row with the
 * other side left null. Fails closed on insufficient funds rather than
 * allowing a negative balance.
 */
export async function debitWallet(
  db: Db,
  characterId: string,
  amountCents: number,
  reason: string
): Promise<TransferResult> {
  if (amountCents <= 0) {
    return { success: false, reason: 'Amount must be positive' };
  }

  return db.transaction(async (tx) => {
    const [wallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.characterId, characterId))
      .for('update')
      .limit(1);

    if (!wallet) {
      return { success: false, reason: `No wallet for character ${characterId}` };
    }
    if (wallet.balanceCents < amountCents) {
      return {
        success: false,
        reason: `Insufficient funds: has ${wallet.balanceCents}, needs ${amountCents}`,
      };
    }

    const [updated] = await tx
      .update(wallets)
      .set({
        balanceCents: wallet.balanceCents - amountCents,
        updatedAt: new Date(),
      })
      .where(eq(wallets.characterId, characterId))
      .returning({ balanceCents: wallets.balanceCents });

    await tx.insert(transactions).values({
      fromCharacterId: characterId,
      toCharacterId: null,
      amountCents,
      reason,
      createdAt: new Date(),
    });

    return { success: true, newFromBalance: updated.balanceCents };
  });
}
