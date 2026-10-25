import type { Strings } from '@fisio/contracts';
import { ApiError } from '../services/api-client';
import { AuthError } from '../services/auth-service';
import { NetworkError } from '../services/network-error';

/**
 * The Italian text for a failed effect (docs/architecture.md §7.1: `error$` carries display-ready
 * text mapped from the code). Catalogued codes have their sentence; a {@link NetworkError} is a
 * request that never reached the server; anything else, a programming error included, is
 * unexpected and never passed off as a connectivity problem. The unexpected one is also logged,
 * so a contract drift or a wrong provider answer leaves a trace behind the one Italian sentence.
 */
export function messageFor(error: unknown, strings: Strings): string {
  if (error instanceof AuthError) return strings.auth.errors[error.code];
  if (error instanceof ApiError) return strings.errors[error.code];
  if (error instanceof NetworkError) return strings.common.offline;
  console.error('[web] unexpected failure', error);
  return strings.common.unexpectedError;
}
