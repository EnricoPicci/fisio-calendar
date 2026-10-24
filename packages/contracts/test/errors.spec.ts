import { describe, expect, it } from 'vitest';
import {
  ERROR_CATALOGUE,
  ERROR_CODES,
  type ErrorCode,
  errorCodeFromProblemType,
  httpStatusOf,
  isErrorCode,
  PROBLEM_TYPE_PREFIX,
  problemTypeOf,
} from '../src/errors';

// docs/architecture.md §5.2. Changing this table is an API change: update the doc first.
const EXPECTED: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  slot_full: 409,
  slot_cancelled: 409,
  slot_past: 422,
  slot_outside_horizon: 422,
  slot_changed: 409,
  already_booked: 409,
  overlapping_booking: 409,
  cutoff_passed: 422,
  rule_overlap: 422,
  client_exists: 409,
  client_blocked: 403,
  conflict_retry_exhausted: 503,
};

describe('ErrorCode catalogue (architecture §5.2)', () => {
  it('lists exactly the catalogued codes with their HTTP status', () => {
    expect(Object.fromEntries(ERROR_CODES.map((code) => [code, httpStatusOf(code)]))).toEqual(
      EXPECTED,
    );
  });

  it('every code has a non-empty meaning for the API documentation', () => {
    for (const code of ERROR_CODES) expect(ERROR_CATALOGUE[code].meaning.length).toBeGreaterThan(0);
  });

  it('codes are snake_case so they are stable in URNs and logs', () => {
    for (const code of ERROR_CODES) expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it('the problem+json type is urn:fisio:error:<code> and round-trips', () => {
    expect(PROBLEM_TYPE_PREFIX).toBe('urn:fisio:error:');
    expect(problemTypeOf('slot_full')).toBe('urn:fisio:error:slot_full');
    for (const code of ERROR_CODES)
      expect(errorCodeFromProblemType(problemTypeOf(code))).toBe(code);
  });

  it('an unknown or foreign problem type maps to no code', () => {
    expect(errorCodeFromProblemType('urn:fisio:error:teapot')).toBeUndefined();
    expect(errorCodeFromProblemType('about:blank')).toBeUndefined();
    expect(errorCodeFromProblemType('urn:fisio:error:')).toBeUndefined();
  });

  it('isErrorCode guards untrusted strings', () => {
    expect(isErrorCode('forbidden')).toBe(true);
    expect(isErrorCode('Forbidden')).toBe(false);
    expect(isErrorCode('toString')).toBe(false);
    expect(isErrorCode('')).toBe(false);
  });
});
