import { describe, it, expect } from 'vitest';
import { validateDirective } from '../directive-validator.js';

describe('validateDirective', () => {
  it('accepts a valid directive', () => {
    const result = validateDirective('Make friends with the mayor and gain their trust.');
    expect(result.valid).toBe(true);
  });

  it('rejects an empty directive', () => {
    const result = validateDirective('');
    expect(result.valid).toBe(false);
  });

  it('rejects a directive over 500 chars', () => {
    const longText = 'a'.repeat(501);
    const result = validateDirective(longText);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('500');
  });

  it('accepts exactly 500 chars', () => {
    const maxText = 'a'.repeat(500);
    const result = validateDirective(maxText);
    expect(result.valid).toBe(true);
  });

  it('rejects 501 chars', () => {
    const overMaxText = 'a'.repeat(501);
    const result = validateDirective(overMaxText);
    expect(result.valid).toBe(false);
  });

  it('rejects whitespace-only directive', () => {
    const result = validateDirective('   ');
    expect(result.valid).toBe(false);
  });
});
