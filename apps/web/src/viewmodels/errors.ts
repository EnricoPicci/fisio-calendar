import type { Strings } from '@fisio/contracts';
import { ApiError } from '../services/api-client';
import { AuthError } from '../services/auth-service';

/**
 * The Italian text for a failed effect (docs/architecture.md §7.1: `error$` carries display-ready
 * text mapped from the code). Catalogued codes have their sentence; a `TypeError` is what `fetch`
 * throws when the network is down; anything else is unexpected.
 */
export function messageFor(error: unknown, strings: Strings): string {
  if (error instanceof AuthError) return strings.auth.errors[error.code];
  if (error instanceof ApiError) return strings.errors[error.code];
  if (error instanceof TypeError) return strings.common.offline;
  return strings.common.unexpectedError;
}
