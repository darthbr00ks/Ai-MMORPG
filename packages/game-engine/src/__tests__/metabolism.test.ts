import { describe, it, expect } from 'vitest';
import {
  applyMetabolismTick,
  DAILY_HUNGER_INCREASE,
  MAX_HUNGER,
  HUNGER_REDUCTION_PER_FOOD_UNIT,
  STARVATION_HUNGER_THRESHOLD,
  STARVATION_HEALTH_DRAIN,
} from '../metabolism.js';

describe('applyMetabolismTick', () => {
  it('increases hunger by DAILY_HUNGER_INCREASE when no food is held', () => {
    const result = applyMetabolismTick({ hunger: 0, health: 100, heldFoodQuantity: 0 });
    expect(result.hunger).toBe(DAILY_HUNGER_INCREASE);
    expect(result.fed).toBe(false);
    expect(result.quantityConsumed).toBe(0);
    expect(result.health).toBe(100);
  });

  it('caps hunger at MAX_HUNGER rather than overflowing', () => {
    const result = applyMetabolismTick({ hunger: MAX_HUNGER, health: 100, heldFoodQuantity: 0 });
    expect(result.hunger).toBe(MAX_HUNGER);
  });

  it('auto-consumes held food to offset the day\'s hunger increase', () => {
    const result = applyMetabolismTick({ hunger: 0, health: 100, heldFoodQuantity: 5 });
    // 0 + 15 = 15, one unit of food (-25, floored at 0) clears it.
    expect(result.hunger).toBe(0);
    expect(result.fed).toBe(true);
    expect(result.quantityConsumed).toBe(1);
  });

  it('eats multiple units in one tick if hunger is high enough to need it', () => {
    const result = applyMetabolismTick({ hunger: 90, health: 100, heldFoodQuantity: 10 });
    // 90 + 15 -> capped at 100. Eating one unit: 100-25=75 (still >0,
    // keep eating). Eating a second: 75-25=50. Stops there — food
    // remains but hunger is already fully cleared to a comfortable
    // level... actually hunger only stops decreasing once it hits 0,
    // so this keeps eating until hunger reaches 0 or food runs out.
    expect(result.hunger).toBe(0);
    expect(result.quantityConsumed).toBe(4); // 100 -> 75 -> 50 -> 25 -> 0
  });

  it('never eats more food than is actually held', () => {
    const result = applyMetabolismTick({ hunger: 100, health: 100, heldFoodQuantity: 1 });
    expect(result.quantityConsumed).toBe(1);
    expect(result.hunger).toBe(100 - HUNGER_REDUCTION_PER_FOOD_UNIT);
  });

  it('does not drain health while hunger stays below the starvation threshold', () => {
    const result = applyMetabolismTick({ hunger: 0, health: 100, heldFoodQuantity: 0 });
    expect(result.hunger).toBeLessThan(STARVATION_HUNGER_THRESHOLD);
    expect(result.starving).toBe(false);
    expect(result.health).toBe(100);
  });

  it('drains health by STARVATION_HEALTH_DRAIN once hunger reaches the starvation threshold with nothing to eat', () => {
    const result = applyMetabolismTick({ hunger: 70, health: 100, heldFoodQuantity: 0 });
    expect(result.hunger).toBe(85); // 70 + 15, no food to offset it
    expect(result.starving).toBe(true);
    expect(result.health).toBe(100 - STARVATION_HEALTH_DRAIN);
  });

  it('never drains health below MIN_HEALTH even under repeated starvation', () => {
    const result = applyMetabolismTick({ hunger: 100, health: 2, heldFoodQuantity: 0 });
    expect(result.health).toBe(0);
  });

  it('is never affected by starvation in the same tick that food fully clears hunger', () => {
    // Progressive-consequences design goal: a character who successfully
    // eats enough to bring hunger back down must not also take a
    // starvation health hit in that same tick.
    const result = applyMetabolismTick({ hunger: 90, health: 100, heldFoodQuantity: 10 });
    expect(result.starving).toBe(false);
    expect(result.health).toBe(100);
  });
});
