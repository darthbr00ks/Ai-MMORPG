import { describe, expect, it } from 'vitest';
import {
  LOCATION_SCENE_LAYOUT,
  buildWorldTiles,
  findWorldPath,
  getConversationMeetingSpots,
  getLocationCharacterSpot,
  isWorldPointWalkable,
} from '@/lib/world-scene-layout';

describe('world-scene-layout', () => {
  it('builds a walkable grid with blocked building footprints', () => {
    const tiles = buildWorldTiles();
    expect(tiles.length).toBeGreaterThan(0);
    expect(
      isWorldPointWalkable(LOCATION_SCENE_LAYOUT.tavern.buildingCenter)
    ).toBe(false);
    expect(
      isWorldPointWalkable(LOCATION_SCENE_LAYOUT['town-square'].characterAnchor)
    ).toBe(true);
  });

  it('finds a non-empty path between seeded locations', () => {
    const start = LOCATION_SCENE_LAYOUT.tavern.characterAnchor;
    const end = LOCATION_SCENE_LAYOUT.market.characterAnchor;
    const path = findWorldPath(
      start,
      end
    );
    expect(path.length).toBeGreaterThan(2);
    expect(path[0]).not.toEqual(path[path.length - 1]);
    expect(
      Math.abs(path[0].x - start.x) + Math.abs(path[0].z - start.z)
    ).toBeLessThanOrEqual(4.5);
    expect(
      Math.abs(path[path.length - 1].x - end.x) + Math.abs(path[path.length - 1].z - end.z)
    ).toBeLessThanOrEqual(4.5);
    expect(path.every((point) => isWorldPointWalkable(point))).toBe(true);
  });

  it('spreads characters within a location and creates paired meeting spots', () => {
    const a = getLocationCharacterSpot('town-square', 0, 4);
    const b = getLocationCharacterSpot('town-square', 1, 4);
    expect(a).not.toEqual(b);

    const meeting = getConversationMeetingSpots('town-square', 'mabel', 'gregor');
    expect(meeting.a.x).not.toBe(meeting.b.x);
    expect(meeting.a.z).not.toBe(meeting.b.z);
  });
});
