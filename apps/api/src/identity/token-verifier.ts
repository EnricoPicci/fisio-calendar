import { type Role, RoleSchema, type TenantId, TenantIdSchema } from '@fisio/contracts';
import type { Clock } from '@fisio/domain';
import { JwtVerifier } from 'aws-jwt-verify';
import { FetchError, JwtBaseError } from 'aws-jwt-verify/error';
import type { Fetcher } from 'aws-jwt-verify/https';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import { z } from 'zod';
import type { AuthConfig } from '../config';

/**
 * Access-token verification (docs/architecture.md §8.2). `aws-jwt-verify` checks the signature
 * against the issuer's JWKS (fetched once and cached), the algorithm, the issuer, and in
 * `customJwtCheck` that this is an access token of our app client. The same code accepts
 * Cognito's tokens and the local emulator's; only the issuer differs.
 *
 * Expiry and not-before are checked here against the `Clock` port instead: `aws-jwt-verify`
 * reads `Date.now()` directly, so with a fixed spec clock its check would pass or fail by the
 * real date. Its own check is switched off with a tolerance no token outlives. In the cloud the
 * clock is the system clock, so the result is the same.
 */
export interface AccessTokenClaims {
  /** The user id (a UUID): the client id for a client (§6.2), the therapist's id otherwise. */
  readonly sub: string;
  readonly role: Role;
  readonly tenantId: TenantId;
}

export interface TokenVerifier {
  /** The token's claims, or `InvalidTokenError` for any token the API must not accept. */
  verify(token: string): Promise<AccessTokenClaims>;
}

/** Why a token was refused, for logs only: the response is always `unauthenticated`. */
export class InvalidTokenError extends Error {
  override readonly name = 'InvalidTokenError';
}

/** 100 years: disables the library's wall-clock expiry check (see above). */
const LIBRARY_EXPIRY_CHECK_OFF = 100 * 365 * 24 * 3600;

/**
 * Claims the pre-token-generation trigger adds (§8.1): `role` and `tenantId`. `sub` is the
 * Cognito user id, which is the client id (§6.2) or the therapist's id.
 */
const ClaimsSchema = z.object({
  sub: z.uuid(),
  role: RoleSchema,
  tenantId: TenantIdSchema,
  exp: z.number(),
  nbf: z.number().optional(),
});

export interface TokenVerifierOptions {
  readonly clock: Clock;
  /** How the JWKS is downloaded; the library's HTTPS fetcher when omitted. */
  readonly fetcher?: Fetcher;
}

export function createTokenVerifier(
  auth: AuthConfig,
  options: TokenVerifierOptions,
): TokenVerifier {
  const verifier = JwtVerifier.create(
    {
      issuer: auth.issuer,
      jwksUri: auth.jwksUri,
      audience: null,
      graceSeconds: LIBRARY_EXPIRY_CHECK_OFF,
      customJwtCheck: ({ payload }) => {
        if (payload.token_use !== 'access') throw new InvalidTokenError('Not an access token');
        if (payload.client_id !== auth.clientId) throw new InvalidTokenError('Wrong app client');
      },
    },
    options.fetcher ? { jwksCache: new SimpleJwksCache({ fetcher: options.fetcher }) } : undefined,
  );

  return {
    async verify(token) {
      let payload: unknown;
      try {
        payload = await verifier.verify(token);
      } catch (error) {
        if (error instanceof InvalidTokenError) throw error;
        // An unreachable JWKS is our fault, not the caller's: answering 401 would sign every
        // user out during an outage, so it propagates as a server error.
        if (error instanceof JwtBaseError && !(error instanceof FetchError)) {
          throw new InvalidTokenError('Token refused by the verifier', { cause: error });
        }
        throw error;
      }
      const claims = ClaimsSchema.safeParse(payload);
      if (!claims.success) throw new InvalidTokenError('Token claims are missing or malformed');
      const nowSeconds = options.clock.now().getTime() / 1000;
      if (claims.data.exp <= nowSeconds) throw new InvalidTokenError('Token expired');
      if (claims.data.nbf !== undefined && claims.data.nbf > nowSeconds) {
        throw new InvalidTokenError('Token not yet valid');
      }
      return { sub: claims.data.sub, role: claims.data.role, tenantId: claims.data.tenantId };
    },
  };
}

/**
 * A JWKS fetcher over the global `fetch`, which also reaches the emulator's plain-HTTP JWKS
 * on 127.0.0.1 (the library's fetcher speaks HTTPS only). Used by the local runtime.
 */
export const fetchJwks: Fetcher = {
  async fetch(uri) {
    const response = await fetch(uri, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`JWKS request failed with HTTP ${response.status}`);
    return response.arrayBuffer();
  },
};
