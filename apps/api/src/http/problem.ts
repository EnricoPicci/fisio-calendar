import {
  ERROR_CATALOGUE,
  type ErrorCode,
  httpStatusOf,
  PROBLEM_MEDIA_TYPE,
  type Problem,
  problemTypeOf,
  type ValidationIssue,
} from '@fisio/contracts';
import { isErrorNamed } from '@fisio/domain';
import { HTTPException } from 'hono/http-exception';
import type { ZodError } from 'zod';

/**
 * Errors as RFC 9457 problem+json (docs/architecture.md §5.2): every error response carries a
 * code from the catalogue in `@fisio/contracts`, and never a stack trace, an internal id or the
 * text of an unexpected error (§9.2).
 */

/** An error a route or use case raises on purpose, with its catalogued code. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  /** A short explanation for the client; never personal data or internal state. */
  readonly detail?: string;
  readonly errors?: readonly ValidationIssue[];

  constructor(
    readonly code: ErrorCode,
    options: { detail?: string; errors?: readonly ValidationIssue[]; cause?: unknown } = {},
  ) {
    super(options.detail ?? ERROR_CATALOGUE[code].meaning, { cause: options.cause });
    if (options.detail) this.detail = options.detail;
    if (options.errors) this.errors = options.errors;
  }
}

export function problemBody(error: ApiError): Problem {
  const status = httpStatusOf(error.code);
  return {
    type: problemTypeOf(error.code),
    code: error.code,
    title: ERROR_CATALOGUE[error.code].meaning,
    status,
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.errors ? { errors: [...error.errors] } : {}),
  };
}

export function problemResponse(error: ApiError): Response {
  const body = problemBody(error);
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: { 'content-type': PROBLEM_MEDIA_TYPE },
  });
}

/**
 * Domain errors that mean "the request named an impossible value": a slot id or a local
 * date/time that is malformed, or a start in the spring-forward gap. They are recognised by
 * name, not `instanceof`, so a second copy of `@fisio/domain` in a bundle still maps them. The
 * use case knows the offending path and should raise `ApiError('validation_failed', { errors })`
 * itself; this fallback reports none.
 *
 * `InvalidTimeZoneError` is not here: no request carries a zone in v1, so it means the runtime
 * lacks tz data, a server fault.
 */
const INVALID_INPUT_ERRORS = [
  'InvalidSlotIdError',
  'NonexistentLocalTimeError',
  'InvalidLocalValueError',
] as const;

/** The `ApiError` that answers `error`; `unexpected` is true when it hides a server fault. */
export function toApiError(error: unknown): { apiError: ApiError; unexpected: boolean } {
  if (error instanceof ApiError) return { apiError: error, unexpected: false };
  if (INVALID_INPUT_ERRORS.some((name) => isErrorNamed(error, name))) {
    return { apiError: new ApiError('validation_failed'), unexpected: false };
  }
  if (error instanceof HTTPException) {
    // Hono's own refusals: a body that is not JSON (400), and nothing else we rely on.
    const code = error.status === 400 ? 'validation_failed' : undefined;
    if (code) return { apiError: new ApiError(code), unexpected: false };
  }
  return { apiError: new ApiError('internal_error'), unexpected: true };
}

const LOCATION_OF_TARGET: Record<string, ValidationIssue['in']> = {
  json: 'body',
  form: 'body',
  query: 'query',
  param: 'path',
  header: 'header',
  cookie: 'header',
};

/** A Zod rejection of one request part as `validation_failed`, listing paths and codes only. */
export function validationError(target: string, error: ZodError): ApiError {
  const location = LOCATION_OF_TARGET[target] ?? 'body';
  return new ApiError('validation_failed', {
    errors: error.issues.map((issue) => ({
      in: location,
      path: issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
      code: issue.code,
    })),
  });
}
