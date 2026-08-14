import { describe, it, expect } from 'vitest';
import {
  clampRelationshipDimension,
  canonicalizeCharacterPair,
  defaultRelationshipDimensions,
  RELATIONSHIP_DIMENSION_MIN,
  RELATIONSHIP_DIMENSION_MAX,
} from '../relationship-engine.js';

describe('clampRelationshipDimension', () => {
  it('leaves in-range values untouched', () => {
    expect(clampRelationshipDimension(0)).toBe(0);
    expect(clampRelationshipDimension(42)).toBe(42);
    expect(clampRelationshipDimension(-42)).toBe(-42);
  });

  it('clamps above the max to the max', () => {
    expect(clampRelationshipDimension(150)).toBe(RELATIONSHIP_DIMENSION_MAX);
    expect(clampRelationshipDimension(RELATIONSHIP_DIMENSION_MAX + 1)).toBe(
      RELATIONSHIP_DIMENSION_MAX
    );
  });

  it('clamps below the min to the min', () => {
    expect(clampRelationshipDimension(-150)).toBe(RELATIONSHIP_DIMENSION_MIN);
    expect(clampRelationshipDimension(RELATIONSHIP_DIMENSION_MIN - 1)).toBe(
      RELATIONSHIP_DIMENSION_MIN
    );
  });

  it('accepts the boundary values exactly', () => {
    expect(clampRelationshipDimension(RELATIONSHIP_DIMENSION_MAX)).toBe(
      RELATIONSHIP_DIMENSION_MAX
    );
    expect(clampRelationshipDimension(RELATIONSHIP_DIMENSION_MIN)).toBe(
      RELATIONSHIP_DIMENSION_MIN
    );
  });
});

describe('canonicalizeCharacterPair', () => {
  it('always returns the lexicographically smaller id first', () => {
    expect(canonicalizeCharacterPair('b', 'a')).toEqual(['a', 'b']);
    expect(canonicalizeCharacterPair('a', 'b')).toEqual(['a', 'b']);
  });

  it('is symmetric — order of arguments never changes the result', () => {
    const forward = canonicalizeCharacterPair('char-xyz', 'char-abc');
    const reverse = canonicalizeCharacterPair('char-abc', 'char-xyz');
    expect(forward).toEqual(reverse);
  });
});

describe('defaultRelationshipDimensions', () => {
  it('starts every dimension at neutral (zero)', () => {
    expect(defaultRelationshipDimensions()).toEqual({
      trust: 0,
      respect: 0,
      affection: 0,
      fear: 0,
      hostility: 0,
      familiarity: 0,
    });
  });

  it('returns a fresh object each call — callers cannot mutate a shared default', () => {
    const first = defaultRelationshipDimensions();
    first.trust = 99;
    const second = defaultRelationshipDimensions();
    expect(second.trust).toBe(0);
  });
});
