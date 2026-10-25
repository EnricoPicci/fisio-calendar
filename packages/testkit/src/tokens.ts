import { createSign, generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';

/**
 * Fake JWTs for API specs and journeys (docs/architecture.md §10.1): an RS256 key pair, its
 * JWKS, and access tokens shaped like Cognito's (`token_use`, `client_id`, the `role` and
 * `tenantId` claims of the pre-token-generation trigger). The API verifies them with its real
 * verifier; only the issuer and the JWKS source differ from production.
 */
export const TEST_ISSUER = 'https://auth.test.invalid/fisio-test';
export const TEST_CLIENT_ID = 'fisio-test-web';
export const TEST_JWKS_URI = `${TEST_ISSUER}/.well-known/jwks.json`;

export interface PublicJwk {
  readonly kty: 'RSA';
  readonly kid: string;
  readonly alg: 'RS256';
  readonly use: 'sig';
  readonly n: string;
  readonly e: string;
}

export interface TokenClaims {
  readonly sub: string;
  readonly role?: string;
  readonly tenantId?: string;
  readonly [claim: string]: unknown;
}

export interface SignOptions {
  /** Token issue instant, normally the spec's `Clock.now()`. */
  readonly issuedAt: Date;
  /** Lifetime in seconds; Cognito's access tokens live 60 minutes (§8.1). */
  readonly expiresInSeconds?: number;
  /** Overrides or removes (`undefined`) standard claims, to build invalid tokens. */
  readonly override?: Readonly<Record<string, unknown>>;
}

export class TestTokenIssuer {
  readonly issuer: string;
  readonly clientId: string;
  readonly kid: string;
  readonly #privateKey: KeyObject;
  readonly #publicJwk: PublicJwk;
  /** The JWKS URIs the API fetched, so a spec can check the cache. */
  readonly jwksRequests: string[] = [];

  constructor(options: { issuer?: string; clientId?: string; kid?: string } = {}) {
    this.issuer = options.issuer ?? TEST_ISSUER;
    this.clientId = options.clientId ?? TEST_CLIENT_ID;
    this.kid = options.kid ?? `test-${randomUUID()}`;
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.#privateKey = privateKey;
    const { n, e } = publicKey.export({ format: 'jwk' });
    this.#publicJwk = {
      kty: 'RSA',
      kid: this.kid,
      alg: 'RS256',
      use: 'sig',
      n: n ?? '',
      e: e ?? '',
    };
  }

  get jwks(): { keys: PublicJwk[] } {
    return { keys: [this.#publicJwk] };
  }

  /**
   * A JWKS fetcher (the `aws-jwt-verify` `Fetcher` shape) that serves this issuer's keys from
   * memory, so specs never touch the network.
   */
  get fetcher(): { fetch(uri: string): Promise<ArrayBuffer> } {
    return {
      fetch: async (uri) => {
        this.jwksRequests.push(uri);
        return new TextEncoder().encode(JSON.stringify(this.jwks)).buffer as ArrayBuffer;
      },
    };
  }

  /** A Cognito-shaped access token for `claims`. */
  accessToken(claims: TokenClaims, options: SignOptions): string {
    const iat = Math.floor(options.issuedAt.getTime() / 1000);
    const payload: Record<string, unknown> = {
      iss: this.issuer,
      client_id: this.clientId,
      token_use: 'access',
      scope: 'aws.cognito.signin.user.admin',
      auth_time: iat,
      iat,
      exp: iat + (options.expiresInSeconds ?? 3600),
      jti: randomUUID(),
      ...claims,
    };
    for (const [claim, value] of Object.entries(options.override ?? {})) {
      if (value === undefined) delete payload[claim];
      else payload[claim] = value;
    }
    return this.sign(payload);
  }

  /** Any payload, signed with this issuer's key: the building block for malformed tokens. */
  sign(
    payload: Readonly<Record<string, unknown>>,
    header: Readonly<Record<string, unknown>> = {},
  ): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: this.kid, ...header })}.${encode(payload)}`;
    const signature = createSign('RSA-SHA256').update(input).sign(this.#privateKey);
    return `${input}.${signature.toString('base64url')}`;
  }
}
