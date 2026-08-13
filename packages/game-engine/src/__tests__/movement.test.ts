import { describe, it, expect } from 'vitest';
import { validateMovement, isLocationConnected } from '../movement.js';

const testLocations = [
  { id: '1', slug: 'town-square', connections: ['tavern', 'market'] },
  { id: '2', slug: 'tavern', connections: ['town-square'] },
  { id: '3', slug: 'market', connections: ['town-square', 'warehouse-district'] },
  { id: '4', slug: 'warehouse-district', connections: ['market'] },
];

describe('validateMovement', () => {
  it('allows movement to connected location', () => {
    const result = validateMovement('town-square', 'tavern', testLocations);
    expect(result.valid).toBe(true);
    expect(result.travelEtaMs).toBeDefined();
  });

  it('rejects movement to non-connected location', () => {
    const result = validateMovement('town-square', 'warehouse-district', testLocations);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not connected');
  });

  it('rejects movement to same location', () => {
    const result = validateMovement('town-square', 'town-square', testLocations);
    expect(result.valid).toBe(false);
  });

  it('rejects movement to unknown destination', () => {
    const result = validateMovement('town-square', 'nonexistent', testLocations);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it('rejects movement from unknown location', () => {
    const result = validateMovement('nowhere', 'tavern', testLocations);
    expect(result.valid).toBe(false);
  });
});

describe('isLocationConnected', () => {
  it('returns true for connected locations', () => {
    expect(isLocationConnected('town-square', 'tavern', testLocations)).toBe(true);
  });

  it('returns false for non-connected locations', () => {
    expect(isLocationConnected('town-square', 'warehouse-district', testLocations)).toBe(false);
  });
});
