import { createSign, generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';

/**
 * RS256 signing for the emulator's tokens. The key pair is made when the emulator starts and
 * lives in memory: a restart invalidates outstanding access tokens, and the API's verifier
 * fetches the new JWKS when it meets the new `kid`. Refresh tokens are stored, so they survive.
 */
export interface PublicJwk {
  readonly kty: 'RSA';
  readonly kid: string;
  readonly alg: 'RS256';
  readonly use: 'sig';
  readonly n: string;
  readonly e: string;
}

export class RsaSigner {
  readonly kid = `emulator-${randomUUID()}`;
  readonly #privateKey: KeyObject;
  readonly #publicJwk: PublicJwk;

  constructor() {
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

  sign(payload: Readonly<Record<string, unknown>>): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: this.kid })}.${encode(payload)}`;
    const signature = createSign('RSA-SHA256').update(input).sign(this.#privateKey);
    return `${input}.${signature.toString('base64url')}`;
  }
}
