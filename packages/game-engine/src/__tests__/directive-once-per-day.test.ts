import { describe, it, expect } from 'vitest';
import { canSubmitDirective } from '../directive-validator.js';

describe('canSubmitDirective', () => {
  it('allows the first-ever submission (no active directive yet)', () => {
    expect(canSubmitDirective(null, 0).valid).toBe(true);
  });

  it('rejects a second submission on the same game day', () => {
    const result = canSubmitDirective(3, 3);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('game day 3');
  });

  it('rejects a submission on a game day earlier than the active directive (should not happen, but must not regress)', () => {
    expect(canSubmitDirective(5, 4).valid).toBe(false);
  });

  it('allows a submission once the game day has advanced', () => {
    expect(canSubmitDirective(3, 4).valid).toBe(true);
  });
});
