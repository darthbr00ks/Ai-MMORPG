export interface WorldPoint {
  x: number;
  z: number;
}

export interface SceneLocationLayout {
  label: string;
  type:
    | 'town-square'
    | 'tavern'
    | 'market'
    | 'house'
    | 'city-hall'
    | 'warehouse'
    | 'farm'
    | 'bank'
    | 'mine'
    | 'guard-station';
  buildingCenter: WorldPoint;
  characterAnchor: WorldPoint;
  footprint?: { width: number; depth: number };
}

export type TerrainType = 'grass' | 'road' | 'dirt' | 'stone';

export interface WorldTile {
  x: number;
  y: number;
  walkable: boolean;
  terrain: TerrainType;
}

export const WORLD_TILE_SIZE = 1.5;
export const WORLD_GRID_RADIUS = 22;
const ROAD_HALF_WIDTH = 1.4;

export const LOCATION_SCENE_LAYOUT: Record<string, SceneLocationLayout> = {
  'town-square': {
    label: 'Town Square',
    type: 'town-square',
    buildingCenter: { x: 0, z: 0 },
    characterAnchor: { x: 0, z: 0 },
  },
  tavern: {
    label: 'Tavern',
    type: 'tavern',
    buildingCenter: { x: -15, z: 9 },
    characterAnchor: { x: -12, z: 5 },
    footprint: { width: 8, depth: 6 },
  },
  market: {
    label: 'Market',
    type: 'market',
    buildingCenter: { x: 16, z: 8 },
    characterAnchor: { x: 12, z: 5 },
    footprint: { width: 10, depth: 8 },
  },
  'residential-district': {
    label: 'Residences',
    type: 'house',
    buildingCenter: { x: -16, z: -10 },
    characterAnchor: { x: -11, z: -7 },
    footprint: { width: 10, depth: 8 },
  },
  'city-hall': {
    label: 'City Hall',
    type: 'city-hall',
    buildingCenter: { x: 10, z: -11 },
    characterAnchor: { x: 7, z: -6 },
    footprint: { width: 8, depth: 7 },
  },
  'warehouse-district': {
    label: 'Warehouse',
    type: 'warehouse',
    buildingCenter: { x: 23, z: 0 },
    characterAnchor: { x: 18, z: 0 },
    footprint: { width: 8, depth: 7 },
  },
  farm: {
    label: 'Farm',
    type: 'farm',
    buildingCenter: { x: 25, z: 17 },
    characterAnchor: { x: 20, z: 14 },
    footprint: { width: 9, depth: 7 },
  },
  bank: {
    label: 'Bank',
    type: 'bank',
    buildingCenter: { x: 23, z: -11 },
    characterAnchor: { x: 18, z: -9 },
    footprint: { width: 7, depth: 6 },
  },
  mine: {
    label: 'Mine',
    type: 'mine',
    buildingCenter: { x: 24, z: -21 },
    characterAnchor: { x: 19, z: -18 },
    footprint: { width: 10, depth: 8 },
  },
  'guard-station': {
    label: 'Guard',
    type: 'guard-station',
    buildingCenter: { x: 2, z: -20 },
    characterAnchor: { x: 4, z: -15 },
    footprint: { width: 7, depth: 6 },
  },
};

export const WORLD_LOCATION_SLUGS = Object.keys(LOCATION_SCENE_LAYOUT);

export const ROAD_SEGMENTS: Array<[string, string]> = [
  ['town-square', 'tavern'],
  ['town-square', 'market'],
  ['town-square', 'city-hall'],
  ['town-square', 'residential-district'],
  ['tavern', 'residential-district'],
  ['market', 'warehouse-district'],
  ['market', 'farm'],
  ['market', 'bank'],
  ['warehouse-district', 'farm'],
  ['warehouse-district', 'mine'],
  ['warehouse-district', 'residential-district'],
  ['city-hall', 'bank'],
  ['city-hall', 'guard-station'],
  ['guard-station', 'mine'],
  ['guard-station', 'residential-district'],
];

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function hashString(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function distanceToSegment(point: WorldPoint, start: WorldPoint, end: WorldPoint) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.z - start.z);
  }
  const t = clamp(
    ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared,
    0,
    1
  );
  const projectedX = start.x + dx * t;
  const projectedZ = start.z + dz * t;
  return Math.hypot(point.x - projectedX, point.z - projectedZ);
}

export function worldPointToTile(point: WorldPoint) {
  return {
    x: Math.round(point.x / WORLD_TILE_SIZE),
    y: Math.round(point.z / WORLD_TILE_SIZE),
  };
}

export function tileToWorldPoint(tile: { x: number; y: number }): WorldPoint {
  return {
    x: tile.x * WORLD_TILE_SIZE,
    z: tile.y * WORLD_TILE_SIZE,
  };
}

export function terrainAtWorldPoint(point: WorldPoint): TerrainType {
  if (Math.abs(point.x) <= 5.5 && Math.abs(point.z) <= 5.5) {
    return 'stone';
  }
  if (
    point.x >= 18 &&
    point.x <= 31 &&
    point.z >= 11 &&
    point.z <= 23
  ) {
    return 'dirt';
  }
  for (const [fromSlug, toSlug] of ROAD_SEGMENTS) {
    const from = LOCATION_SCENE_LAYOUT[fromSlug].characterAnchor;
    const to = LOCATION_SCENE_LAYOUT[toSlug].characterAnchor;
    if (distanceToSegment(point, from, to) <= ROAD_HALF_WIDTH) {
      return 'road';
    }
  }
  return 'grass';
}

export function isWorldPointWalkable(point: WorldPoint) {
  if (
    point.x < -WORLD_GRID_RADIUS * WORLD_TILE_SIZE ||
    point.x > WORLD_GRID_RADIUS * WORLD_TILE_SIZE ||
    point.z < -WORLD_GRID_RADIUS * WORLD_TILE_SIZE ||
    point.z > WORLD_GRID_RADIUS * WORLD_TILE_SIZE
  ) {
    return false;
  }

  for (const layout of Object.values(LOCATION_SCENE_LAYOUT)) {
    if (!layout.footprint) continue;
    const dx = Math.abs(point.x - layout.buildingCenter.x);
    const dz = Math.abs(point.z - layout.buildingCenter.z);
    if (
      dx <= layout.footprint.width / 2 &&
      dz <= layout.footprint.depth / 2
    ) {
      return false;
    }
  }

  return true;
}

function movementCost(tile: { x: number; y: number }) {
  const terrain = terrainAtWorldPoint(tileToWorldPoint(tile));
  switch (terrain) {
    case 'road':
      return 1;
    case 'stone':
      return 1.05;
    case 'dirt':
      return 1.2;
    case 'grass':
    default:
      return 1.4;
  }
}

function heuristic(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function tileKey(tile: { x: number; y: number }) {
  return `${tile.x},${tile.y}`;
}

function nearestWalkableTile(start: { x: number; y: number }) {
  if (isWorldPointWalkable(tileToWorldPoint(start))) {
    return start;
  }
  for (let radius = 1; radius <= 4; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const candidate = { x: start.x + dx, y: start.y + dy };
        if (isWorldPointWalkable(tileToWorldPoint(candidate))) {
          return candidate;
        }
      }
    }
  }
  return start;
}

export function buildWorldTiles() {
  const tiles: WorldTile[] = [];
  for (let x = -WORLD_GRID_RADIUS; x <= WORLD_GRID_RADIUS; x++) {
    for (let y = -WORLD_GRID_RADIUS; y <= WORLD_GRID_RADIUS; y++) {
      const point = tileToWorldPoint({ x, y });
      tiles.push({
        x,
        y,
        walkable: isWorldPointWalkable(point),
        terrain: terrainAtWorldPoint(point),
      });
    }
  }
  return tiles;
}

export function findWorldPath(start: WorldPoint, end: WorldPoint): WorldPoint[] {
  const startTile = nearestWalkableTile(worldPointToTile(start));
  const endTile = nearestWalkableTile(worldPointToTile(end));
  if (startTile.x === endTile.x && startTile.y === endTile.y) {
    return [tileToWorldPoint(startTile)];
  }

  const open = new Set<string>([tileKey(startTile)]);
  const cameFrom = new Map<string, { x: number; y: number }>();
  const gScore = new Map<string, number>([[tileKey(startTile), 0]]);
  const fScore = new Map<string, number>([
    [tileKey(startTile), heuristic(startTile, endTile)],
  ]);

  while (open.size > 0) {
    const currentKey = Array.from(open).reduce((best, candidate) =>
      (fScore.get(candidate) ?? Number.POSITIVE_INFINITY) <
      (fScore.get(best) ?? Number.POSITIVE_INFINITY)
        ? candidate
        : best
    );
    const [cx, cy] = currentKey.split(',').map(Number);
    const current = { x: cx, y: cy };

    if (current.x === endTile.x && current.y === endTile.y) {
      const path: WorldPoint[] = [tileToWorldPoint(endTile)];
      let cursorKey = currentKey;
      while (cameFrom.has(cursorKey)) {
        const previous = cameFrom.get(cursorKey)!;
        path.unshift(tileToWorldPoint(previous));
        cursorKey = tileKey(previous);
      }
      return path;
    }

    open.delete(currentKey);
    const neighbors = [
      { x: current.x + 1, y: current.y },
      { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x, y: current.y - 1 },
    ];

    for (const neighbor of neighbors) {
      if (
        neighbor.x < -WORLD_GRID_RADIUS ||
        neighbor.x > WORLD_GRID_RADIUS ||
        neighbor.y < -WORLD_GRID_RADIUS ||
        neighbor.y > WORLD_GRID_RADIUS
      ) {
        continue;
      }
      if (!isWorldPointWalkable(tileToWorldPoint(neighbor))) {
        continue;
      }
      const neighborKey = tileKey(neighbor);
      const tentativeG =
        (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) +
        movementCost(neighbor);
      if (tentativeG >= (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }
      cameFrom.set(neighborKey, current);
      gScore.set(neighborKey, tentativeG);
      fScore.set(neighborKey, tentativeG + heuristic(neighbor, endTile));
      open.add(neighborKey);
    }
  }

  return [tileToWorldPoint(startTile), tileToWorldPoint(endTile)];
}

export function getLocationCharacterSpot(
  locationSlug: string,
  indexWithinLocation: number,
  countAtLocation: number
): WorldPoint {
  const base = LOCATION_SCENE_LAYOUT[locationSlug]?.characterAnchor;
  if (!base) {
    return { x: 0, z: 0 };
  }
  if (countAtLocation <= 1) {
    return { x: base.x, z: base.z };
  }

  const columns = Math.min(3, Math.ceil(Math.sqrt(countAtLocation)));
  const spacing = 2.2;
  const row = Math.floor(indexWithinLocation / columns);
  const column = indexWithinLocation % columns;
  const rowCount = Math.ceil(countAtLocation / columns);
  return {
    x: base.x + (column - (columns - 1) / 2) * spacing,
    z: base.z + (row - (rowCount - 1) / 2) * spacing,
  };
}

export function getConversationMeetingSpots(
  locationSlug: string,
  participantAId: string,
  participantBId: string
) {
  const base = LOCATION_SCENE_LAYOUT[locationSlug]?.characterAnchor ?? { x: 0, z: 0 };
  const angle = (hashString(`${participantAId}|${participantBId}`) % 360) * (Math.PI / 180);
  const center = {
    x: base.x + Math.cos(angle) * 1.8,
    z: base.z + Math.sin(angle) * 1.8,
  };
  const normal = {
    x: -Math.sin(angle),
    z: Math.cos(angle),
  };
  return {
    a: {
      x: center.x + normal.x * 0.9,
      z: center.z + normal.z * 0.9,
    },
    b: {
      x: center.x - normal.x * 0.9,
      z: center.z - normal.z * 0.9,
    },
    center,
  };
}
