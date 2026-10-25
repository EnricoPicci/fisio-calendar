/**
 * The ErrorCode catalogue (docs/architecture.md §5.2, decision 14A): the only list of API error
 * codes. The API answers with RFC 9457 problem+json whose `type` is `urn:fisio:error:<code>`;
 * the SPA maps codes to Italian strings; specs assert codes, never sentences.
 */
export const ERROR_CATALOGUE = {
  validation_failed: { status: 400, meaning: 'Zod rejected the request (details list the paths)' },
  unauthenticated: { status: 401, meaning: 'Missing or invalid token' },
  forbidden: {
    status: 403,
    meaning: 'Wrong role, not the owner, or client status is not enabled',
  },
  not_found: { status: 404, meaning: 'Resource does not exist for this caller' },
  slot_full: { status: 409, meaning: 'Booking refused: the slot has no places left' },
  slot_cancelled: { status: 409, meaning: 'Booking refused: the slot is cancelled' },
  slot_past: { status: 422, meaning: 'Booking refused: the slot has already started' },
  slot_outside_horizon: {
    status: 422,
    meaning: 'Booking refused: the slot is beyond the booking horizon',
  },
  slot_changed: {
    status: 409,
    meaning: 'Slot generation differs from the one the client displayed: reload',
  },
  already_booked: { status: 409, meaning: 'Client already holds a booking in this slot' },
  overlapping_booking: { status: 409, meaning: 'Defence-in-depth overlap check (§3.2)' },
  cutoff_passed: {
    status: 422,
    meaning: 'Client tried to free a slot at or after the cutoff',
  },
  rule_overlap: { status: 422, meaning: 'Rule would overlap another rule in time (any type)' },
  client_exists: { status: 409, meaning: 'A client with this email exists' },
  client_blocked: { status: 403, meaning: 'Operation refused because the client is blocked' },
  conflict_retry_exhausted: {
    status: 503,
    meaning: 'Transaction conflicts persisted through every bounded retry: retry later',
  },
  internal_error: {
    status: 500,
    meaning: 'Unexpected server error; the response discloses nothing about it',
  },
} as const satisfies Record<string, { status: number; meaning: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOGUE;

export const ERROR_CODES = Object.keys(ERROR_CATALOGUE) as readonly ErrorCode[];

export const PROBLEM_TYPE_PREFIX = 'urn:fisio:error:';

export type ProblemType = `${typeof PROBLEM_TYPE_PREFIX}${ErrorCode}`;

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_CATALOGUE, value);
}

export function httpStatusOf(code: ErrorCode): (typeof ERROR_CATALOGUE)[ErrorCode]['status'] {
  return ERROR_CATALOGUE[code].status;
}

export function problemTypeOf(code: ErrorCode): ProblemType {
  return `${PROBLEM_TYPE_PREFIX}${code}`;
}

/** The code behind a problem+json `type`, or undefined for anything not in the catalogue. */
export function errorCodeFromProblemType(type: string): ErrorCode | undefined {
  if (!type.startsWith(PROBLEM_TYPE_PREFIX)) return undefined;
  const code = type.slice(PROBLEM_TYPE_PREFIX.length);
  return isErrorCode(code) ? code : undefined;
}
