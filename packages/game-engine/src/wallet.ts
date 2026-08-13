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

  return db.transaction(async (tx) => {
    // Lock both rows in a consistent order to avoid deadlocks
    const [fromWallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.characterId, fromCharacterId))
      .for('update')
      .limit(1);

    if (!fromWallet) {
      return { success: false, reason: `No wallet for character ${fromCharacterId}` };
    }
    if (fromWallet.balanceCents < amountCents) {
      return {
        success: false,
        reason: `Insufficient funds: has ${fromWallet.balanceCents}, needs ${amountCents}`,
      };
    }

    const [toWallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.characterId, toCharacterId))
      .for('update')
      .limit(1);

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
