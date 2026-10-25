/**
 * Sign-in failure codes (docs/architecture.md §3.3 C1, T1; §8.1). The SPA's `AuthService` (WP0.7)
 * maps Cognito's exceptions and the local auth emulator's answers onto this one list, so view-models
 * and specs see the same codes whichever implementation runs. Specs assert codes, never sentences.
 * Unknown, blocked and therapist emails on the code flow are never distinguished (no account
 * enumeration): they end in `code_mismatch` like a mistyped code.
 */
export const AUTH_ERROR_CATALOGUE = {
  code_mismatch: 'The one-time or TOTP code is wrong',
  code_expired: 'The one-time code has expired: request a new one',
  too_many_attempts: 'Too many wrong attempts: sign-in is locked for a while',
  not_authorized: 'Wrong email or password, unusable setup code, or a refused refresh',
  invalid_session: 'The sign-in step refers to an unknown or finished session',
  invalid_password: 'The new password does not meet the policy (12+ characters)',
} as const satisfies Record<string, string>;

export type AuthErrorCode = keyof typeof AUTH_ERROR_CATALOGUE;

export const AUTH_ERROR_CODES = Object.keys(AUTH_ERROR_CATALOGUE) as readonly AuthErrorCode[];

export function isAuthErrorCode(value: string): value is AuthErrorCode {
  return Object.hasOwn(AUTH_ERROR_CATALOGUE, value);
}

/** The therapist's password policy (§8.1). */
export const MIN_PASSWORD_LENGTH = 12;

/** The tenant id of the one therapist (§1.1 tenant-ready, single tenant) on every stage. */
export const DEFAULT_TENANT_ID = 'main';
