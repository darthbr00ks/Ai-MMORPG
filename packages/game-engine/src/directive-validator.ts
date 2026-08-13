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
