import type { Strings } from '@fisio/contracts';
import { ApiError } from '../services/api-client';
import { AuthError } from '../services/auth-service';
import { NetworkError } from '../services/network-error';

/**
 * The Italian text for a failed effect (docs/architecture.md §7.1: `error$` carries display-ready
 * text mapped from the code). Catalogued codes have their sentence; a {@link NetworkError} is a
 * request that never reached the server; anything else, a programming error included, is
 * unexpected and never passed off as a connectivity problem.
 */
export function messageFor(error: unknown, strings: Strings): string {
  if (error instanceof AuthError) return strings.auth.errors[error.code];
  if (error instanceof ApiError) return strings.errors[error.code];
  if (error instanceof NetworkError) return strings.common.offline;
  return strings.common.unexpectedError;
}
