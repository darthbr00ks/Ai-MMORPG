export interface DirectiveValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateDirective(text: string, maxChars = 500): DirectiveValidationResult {
  if (!text || text.trim().length === 0) {
    return { valid: false, reason: 'Directive cannot be empty' };
  }
  if (text.length > maxChars) {
    return {
      valid: false,
      reason: `Directive must be ${maxChars} characters or fewer (got ${text.length})`,
    };
  }
  return { valid: true };
}

/**
 * One directive submission per game day (§3/§54 of the build plan).
 * A character with no active directive yet (`activeDirectiveGameDay ===
 * null`) may always submit. Otherwise, a new submission is only allowed
 * once `currentGameDay` has advanced past the day the active directive
 * was submitted on.
 */
export function canSubmitDirective(
  activeDirectiveGameDay: number | null,
  currentGameDay: number
): DirectiveValidationResult {
  if (activeDirectiveGameDay === null) {
    return { valid: true };
  }
  if (currentGameDay > activeDirectiveGameDay) {
    return { valid: true };
  }
  return {
    valid: false,
    reason: `A directive was already submitted for game day ${activeDirectiveGameDay}. Try again next game day.`,
  };
}
