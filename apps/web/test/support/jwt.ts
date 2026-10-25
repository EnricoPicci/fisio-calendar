import type { AuthTokens } from '../../src/services/auth-service';
import type { TokenClaims } from '../../src/services/jwt';

/** An unsigned JWT with these claims: enough for the SPA, which never verifies tokens. */
export function fakeJwt(claims: TokenClaims & Record<string, unknown>): string {
  // base64url of the UTF-8 bytes, as a real token is encoded.
  const encode = (value: unknown) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

/**
 * Access and ID tokens for `role`, the access token expiring at `exp` (seconds since the epoch);
 * `sub` names one user per role unless given.
 */
export function fakeTokens(
  role: 'client' | 'therapist',
  exp: number,
  email?: string,
  sub = `${role}-sub`,
): AuthTokens {
  return {
    accessToken: fakeJwt({ sub, role, exp, token_use: 'access' }),
    idToken: fakeJwt({ sub, role, exp, token_use: 'id', email }),
  };
}
