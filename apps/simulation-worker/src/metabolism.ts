import { eq, inArray } from 'drizzle-orm';
import type { Db } from '@ai-world/database';
import { characterState, inventory, items, gameEvents } from '@ai-world/database';
import { removeFromInventory, applyMetabolismTick } from '@ai-world/game-engine';

export interface DailyMetabolismResult {
  charactersProcessed: number;
  charactersFed: number;
  charactersStarving: number;
  errors: string[];
}

/**
 * Once-per-game-day hunger pass (economy-phase-1's §5: character
 * needs) — called from the same "a new day just started" hook as
 * extractDailyMemories/generateDailyReports, not per tick, for the
 * identical reason: this is a periodic background process, not a
 * per-decision cost.
 *
 * DB-orchestration only — the actual hunger/health math is the pure,
 * independently-unit-tested `applyMetabolismTick` in
 * @ai-world/game-engine (deliberately kept out of this file: sweeping
 * every character in the table, which this function does, is exactly
 * the kind of thing that shouldn't need a real database to test).
 */
export async function applyDailyMetabolism(db: Db): Promise<DailyMetabolismResult> {
  const errors: string[] = [];
  let charactersFed = 0;
  let charactersStarving = 0;

  const foodItemRows = await db.select({ id: items.id, name: items.name }).from(items).where(eq(items.category, 'food'));
  const foodItemIds = foodItemRows.map((i) => i.id);
  const foodItemNameById = new Map(foodItemRows.map((i) => [i.id, i.name]));

  const allStates = await db
    .select({ characterId: characterState.characterId, hunger: characterState.hunger, health: characterState.health })
    .from(characterState);

  // Held food inventory per character — empty map if the world has no
  // food-category items seeded at all, which every branch below
  // already handles as "nothing to eat."
  const foodInventoryByCharacterId = new Map<string, Array<{ itemId: string; quantity: number }>>();
  if (foodItemIds.length > 0) {
    const foodInventoryRows = await db
      .select({ characterId: inventory.characterId, itemId: inventory.itemId, quantity: inventory.quantity })
      .from(inventory)
      .where(inArray(inventory.itemId, foodItemIds));
    for (const row of foodInventoryRows) {
      if (row.quantity <= 0) continue;
      const list = foodInventoryByCharacterId.get(row.characterId) ?? [];
      list.push({ itemId: row.itemId, quantity: row.quantity });
      foodInventoryByCharacterId.set(row.characterId, list);
    }
  }

  // Each character's own state row and own inventory rows — fully
  // independent of every other character's, same rationale as
  // memory-extraction.ts's Promise.all fan-out.
  const perCharacterResults = await Promise.all(allStates.map((state) => applyToCharacter(state)));

  for (const result of perCharacterResults) {
    if (result.fed) charactersFed++;
    if (result.starving) charactersStarving++;
    if (result.error) errors.push(result.error);
  }

  return { charactersProcessed: allStates.length, charactersFed, charactersStarving, errors };

  async function applyToCharacter(state: {
    characterId: string;
    hunger: number;
    health: number;
  }): Promise<{ fed: boolean; starving: boolean; error?: string }> {
    try {
      const heldFood = foodInventoryByCharacterId.get(state.characterId) ?? [];
      const heldFoodQuantity = heldFood.reduce((sum, f) => sum + f.quantity, 0);

      const outcome = applyMetabolismTick({
        hunger: state.hunger,
        health: state.health,
        heldFoodQuantity,
      });

      // The pure function only decided HOW MANY units to eat — actually
      // remove them from inventory here, across however many rows it
      // takes, via the existing atomic removeFromInventory (same
      // function BUY_ITEM/SELL_ITEM use, so this can never under/over-
      // consume relative to what's really held even under concurrent
      // access).
      let remainingToConsume = outcome.quantityConsumed;
      let consumedItemId: string | null = null;
      for (const holding of heldFood) {
        if (remainingToConsume <= 0) break;
        const takeFromThisItem = Math.min(remainingToConsume, holding.quantity);
        if (takeFromThisItem <= 0) continue;
        const removal = await removeFromInventory(db, state.characterId, holding.itemId, takeFromThisItem);
        if (removal.success) {
          remainingToConsume -= takeFromThisItem;
          consumedItemId = holding.itemId;
        }
        // A failed removal (e.g. a concurrent process already took it)
        // just means fewer units actually got consumed than planned —
        // move on to the next held item rather than treating it as a
        // hard failure for this character's whole metabolism pass.
      }
      const actuallyConsumed = outcome.quantityConsumed - remainingToConsume;

      await db
        .update(characterState)
        .set({ hunger: outcome.hunger, health: outcome.health, updatedAt: new Date() })
        .where(eq(characterState.characterId, state.characterId));

      if (actuallyConsumed > 0 && consumedItemId) {
        await db.insert(gameEvents).values({
          type: 'CHARACTER_ATE',
          actorCharacterId: state.characterId,
          payload: {
            item_id: consumedItemId,
            item_name: foodItemNameById.get(consumedItemId) ?? 'food',
            quantity_consumed: actuallyConsumed,
            hunger_after: outcome.hunger,
          },
          importance: 0.1,
          createdAt: new Date(),
        });
      }
      if (outcome.starving) {
        await db.insert(gameEvents).values({
          type: 'CHARACTER_STARVING',
          actorCharacterId: state.characterId,
          payload: { hunger: outcome.hunger, health: outcome.health },
          importance: 0.35,
          createdAt: new Date(),
        });
      }

      return { fed: actuallyConsumed > 0, starving: outcome.starving };
    } catch (err) {
      return { fed: false, starving: false, error: `Character ${state.characterId}: ${String(err)}` };
    }
  }
}
