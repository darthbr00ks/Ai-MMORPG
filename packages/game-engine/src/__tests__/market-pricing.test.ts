import { describe, it, expect } from 'vitest';
import { calculateMarketPrice, MIN_PRICE_MULTIPLIER, MAX_PRICE_MULTIPLIER } from '../market-pricing.js';

describe('calculateMarketPrice', () => {
  it('returns exactly the base price when purchases and sales are balanced', () => {
    expect(calculateMarketPrice(100, 5, 5)).toBe(100);
    expect(calculateMarketPrice(100, 0, 0)).toBe(100);
  });

  it('rises above base price under net buying pressure', () => {
    const price = calculateMarketPrice(100, 10, 0);
    expect(price).toBeGreaterThan(100);
  });

  it('falls below base price under net selling pressure', () => {
    const price = calculateMarketPrice(100, 0, 10);
    expect(price).toBeLessThan(100);
  });

  it('never exceeds MAX_PRICE_MULTIPLIER even under extreme buying pressure', () => {
    const price = calculateMarketPrice(100, 10_000, 0);
    expect(price).toBe(Math.round(100 * MAX_PRICE_MULTIPLIER));
  });

  it('never drops below MIN_PRICE_MULTIPLIER even under extreme selling pressure', () => {
    const price = calculateMarketPrice(100, 0, 10_000);
    expect(price).toBe(Math.round(100 * MIN_PRICE_MULTIPLIER));
  });

  it('is never free, even for a near-worthless base price under a total glut', () => {
    const price = calculateMarketPrice(1, 0, 10_000);
    expect(price).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic — same inputs always produce the same price', () => {
    expect(calculateMarketPrice(80, 7, 3)).toBe(calculateMarketPrice(80, 7, 3));
  });
});
