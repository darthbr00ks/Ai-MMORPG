/**
 * Hand-placed 2D coordinates for New Concord's location graph, used only
 * by the world-map spectator view (apps/web/src/components/WorldMap.tsx).
 *
 * The simulation itself models locations as a graph, not a map (§2 of
 * the build plan — "graph of locations, not a map"), so there is no
 * authoritative x/y anywhere in the schema. These coordinates are a
 * presentation-layer fiction, roughly mirroring the seeded connections
 * graph (packages/database/src/seed.ts's LOCATIONS) so that edges drawn
 * between connected nodes don't cross more than necessary. If a new
 * location is ever added to the seed without a matching entry here,
 * WorldMap skips rendering it (and its characters) rather than guessing
 * a position — see WorldMap's `locationLayoutIsKnown` check.
 */
/** A bare x/y — used for anything that isn't itself a location on the
 * map (e.g. a character's offset from the location they're standing
 * at), where a tile icon type doesn't apply. */
export interface Point {
  x: number;
  y: number;
}

export interface WorldMapPoint extends Point {
  /** Determines which SVG tile icon is rendered for this location node. */
  type: LocationNodeType;
}

export type LocationNodeType =
  | 'plaza'
  | 'tavern'
  | 'market'
  | 'home'
  | 'cityhall'
  | 'warehouse'
  | 'farm'
  | 'bank'
  | 'mine'
  | 'guard';

// Height has headroom below the lowest nodes (mine/guard-station at
// y=620-630) for their name labels at LOCATION_LABEL_OFFSET_Y (78px) —
// see WorldMap.tsx.
export const WORLD_MAP_VIEWBOX = { width: 1050, height: 740 } as const;

export const LOCATION_LAYOUT: Record<string, WorldMapPoint> = {
  'town-square':          { x: 500, y: 330, type: 'plaza' },
  tavern:                 { x: 250, y: 170, type: 'tavern' },
  market:                 { x: 760, y: 170, type: 'market' },
  'residential-district': { x: 250, y: 490, type: 'home' },
  'city-hall':            { x: 750, y: 490, type: 'cityhall' },
  'warehouse-district':   { x: 950, y: 330, type: 'warehouse' },
  farm:                   { x: 950, y: 150, type: 'farm' },
  bank:                   { x: 950, y: 490, type: 'bank' },
  mine:                   { x: 950, y: 620, type: 'mine' },
  'guard-station':        { x: 500, y: 630, type: 'guard' },
};

/**
 * Evenly-spaced offset for the `indexWithinLocation`-th of
 * `countAtLocation` characters standing at the same location, so a
 * crowded hub (City Hall, the Tavern) fans its characters out around
 * the node in a clean ring instead of a hash-based scatter that can
 * coincidentally cluster several of them on the same side — the
 * failure mode an earlier per-character-hash version of this function
 * actually hit at this project's 20-character/10-location alpha
 * density (see docs/architecture.md's World Map section). The caller
 * is responsible for a stable, deterministic ordering (sort by
 * character id) so a given character doesn't jump slots between
 * snapshot polls just because Array.prototype.sort ran differently.
 */
export function characterOffsetWithinLocation(
  indexWithinLocation: number,
  countAtLocation: number
): Point {
  if (countAtLocation <= 1) {
    // The lone occupant sits just off-center — enough that the location
    // node's own ring is still visible peeking out from behind them.
    return { x: 0, y: -30 };
  }
  // A pair (the single most common group size — two characters mid
  // conversation) split left/right instead of top/bottom: their name
  // labels then sit beside each avatar rather than directly under it,
  // clear of both each other and the location's own name label below
  // the node (WorldMap's LOCATION_LABEL_OFFSET_Y). Larger groups start
  // at the top (-90°) instead, which only ever puts one member near
  // that bottom label zone rather than two.
  const startAngle = countAtLocation === 2 ? 0 : -Math.PI / 2;
  const angle = startAngle + (indexWithinLocation / countAtLocation) * 2 * Math.PI;
  // Grows with the crowd so name labels (wider than the avatars
  // themselves) get more arc length to spread into — a fixed radius
  // reads fine for 2-3 characters but crushes their labels together
  // at a busy hub like City Hall with 4+ people standing there.
  const radius = 44 + Math.min(countAtLocation, 8) * 7;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}
