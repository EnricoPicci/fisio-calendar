/**
 * The claims of a JWT, read without verifying it: the SPA only uses them to know who is signed
 * in (role, email) and when the access token expires; the API verifies every token it receives.
 */
export interface TokenClaims {
  readonly sub?: string;
  /** Expiry, seconds since the epoch. */
  readonly exp?: number;
  /** `client` or `therapist` (the pre-token-generation trigger, or the emulator). */
  readonly role?: string;
  /** On ID tokens only. */
  readonly email?: string;
}

/** The payload of `token`; `{}` for anything that is not a JWT with a JSON payload. */
export function decodeJwtClaims(token: string): TokenClaims {
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims: unknown = JSON.parse(json);
    return claims && typeof claims === 'object' ? (claims as TokenClaims) : {};
  } catch {
    return {};
  }
}
