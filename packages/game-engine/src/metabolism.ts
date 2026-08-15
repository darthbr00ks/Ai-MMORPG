/**
 * Pure daily hunger/health math (economy-phase-1's §5: character
 * needs) — deterministic on purpose, same reasoning as market-pricing.ts:
 * the engine calculates, the model never does (§20 of the build plan),
 * and a pure function over its inputs is exhaustively unit-testable
 * without needing a database at all. The DB-orchestration half (which
 * characters exist, what food they actually hold, writing the result
 * back) lives in apps/simulation-worker/src/metabolism.ts — kept
 * separate specifically so a whole-table sweep test never has to touch
 * a real database, whole-table sweeps being exactly what that
 * orchestration layer does once per real game day.
 */

// Roughly a week of going entirely unfed takes a character from
// comfortable (0) to starving (100) — slow enough that missing a
// single day never matters, per the design goal of progressive, not
// instant, consequences.
export const DAILY_HUNGER_INCREASE = 15;
export const MAX_HUNGER = 100;

// One unit of any food-category item offsets a bit under two days'
// worth of hunger — encourages holding a small buffer rather than
// buying exactly one unit right before running out.
export const HUNGER_REDUCTION_PER_FOOD_UNIT = 25;

// At/above this, sustained hunger starts costing real health rather
// than just being an uncomfortable number — still gradual (a handful
// of missed feedings, not one).
export const STARVATION_HUNGER_THRESHOLD = 80;
export const STARVATION_HEALTH_DRAIN = 5;
export const MIN_HEALTH = 0;

export interface MetabolismInput {
  hunger: number;
  health: number;
  // A single aggregate count, not per-item-id — this function decides
  // HOW MANY units get eaten and what that does to hunger/health; WHICH
  // specific inventory rows those units come from is an orchestration
  // detail the caller (apps/simulation-worker/src/metabolism.ts) owns.
  heldFoodQuantity: number;
}

export interface MetabolismOutcome {
  hunger: number;
  health: number;
  quantityConsumed: number;
  fed: boolean;
  starving: boolean;
}

/**
 * One day's worth of hunger drift, followed by auto-consuming held
 * food to offset it (greedy: eat until hunger clears or food runs
 * out), followed by a health penalty if hunger is still critical
 * afterward. Never mutates its input — always returns a fresh result.
 */
export function applyMetabolismTick(input: MetabolismInput): MetabolismOutcome {
  let hunger = Math.min(MAX_HUNGER, input.hunger + DAILY_HUNGER_INCREASE);
  let remainingFood = input.heldFoodQuantity;
  let quantityConsumed = 0;

  while (hunger > 0 && remainingFood > 0) {
    hunger = Math.max(0, hunger - HUNGER_REDUCTION_PER_FOOD_UNIT);
    remainingFood--;
    quantityConsumed++;
  }

  const starving = hunger >= STARVATION_HUNGER_THRESHOLD;
  const health = starving ? Math.max(MIN_HEALTH, input.health - STARVATION_HEALTH_DRAIN) : input.health;

  return { hunger, health, quantityConsumed, fed: quantityConsumed > 0, starving };
}
