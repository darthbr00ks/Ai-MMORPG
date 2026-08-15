/**
 * Dynamic NPC-market pricing (economy-phase-1's answer to the review
 * finding that `items.basePriceCents` never moved regardless of how
 * heavily an item was traded — see docs/architecture.md's Economy
 * Phase 1 section). Deliberately world-wide, not per-location: Phase
 * 12 shipped one fixed catalog "not a per-location assortment" and
 * this doesn't change that scope, it only makes the one catalog's
 * prices react to how the whole world has actually been trading it
 * recently, using the existing ITEM_PURCHASED/ITEM_SOLD game_events
 * as the demand signal — no new location-inventory table.
 *
 * Pure and deterministic on purpose (§20 of the build plan: the engine
 * calculates, the model never does) — same reason action-validator.ts
 * and wallet.ts's mutation functions are plain functions over their
 * inputs rather than reaching for ambient state.
 */

// How far a single net trade (one purchase net of one sale, within the
// pricing window) moves price, as a fraction of the base price. At this
// constant, ~25 net purchases saturates the multiplier at its ceiling —
// plausible pressure for a 20-character world trading a handful of
// items, not so twitchy that one BUY_ITEM call visibly swings the price
// the very next tick.
const PRICE_PRESSURE_PER_NET_TRADE = 0.02;

// Bounds so a trading frenzy (or a dead market) can't send price to
// zero or to a number that breaks downstream cents-as-integer math.
// The doc calling for this framed it as "sensible minimum and maximum
// price boundaries to avoid numerical explosions" — this is that.
export const MIN_PRICE_MULTIPLIER = 0.5;
export const MAX_PRICE_MULTIPLIER = 2.0;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The price BUY_ITEM/SELL_ITEM should actually use for this item right
 * now — `basePriceCents` adjusted by how much net *buying* pressure
 * (purchases minus sales) this item has seen within the caller's
 * chosen recency window. More net buying pushes price up (scarcity);
 * more net selling pushes it down (glut). Always at least 1 cent —
 * never free, no matter how deep a glut.
 */
export function calculateMarketPrice(
  basePriceCents: number,
  recentPurchaseCount: number,
  recentSaleCount: number
): number {
  const netDemand = recentPurchaseCount - recentSaleCount;
  const multiplier = clamp(
    1 + netDemand * PRICE_PRESSURE_PER_NET_TRADE,
    MIN_PRICE_MULTIPLIER,
    MAX_PRICE_MULTIPLIER
  );
  return Math.max(1, Math.round(basePriceCents * multiplier));
}
