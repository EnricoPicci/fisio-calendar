import { closeTestDocumentClient, TEST_CLIENT_ID, TestTokenIssuer } from '@fisio/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHarness } from './harness';

const h = apiHarness();
afterAll(closeTestDocumentClient);

let client: Awaited<ReturnType<typeof h.seedClient>>;
beforeAll(async () => {
  client = await h.seedClient('enabled');
});

/** The claims of a valid client token, for building invalid variants. */
const claims = () => ({ sub: client.clientId, role: 'client', tenantId: h.tenantId });
const sign = (override: Record<string, unknown>, expiresInSeconds?: number) =>
  h.issuer.accessToken(claims(), {
    issuedAt: h.clock.now(),
    override,
    ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
  });

async function expectUnauthenticated(headers: Record<string, string>) {
  const res = await h.call('GET', '/me', { headers });
  expect(res.status).toBe(401);
  expect(res.body.code).toBe('unauthenticated');
  // RFC 9110 §15.5.2 / RFC 6750 §3: a 401 names the scheme the client must use.
  expect(res.headers.get('www-authenticate')).toBe('Bearer');
}

describe('all: missing or invalid token → 401 unauthenticated (architecture §8.2)', () => {
  // Value: protects=a protected route never runs without credentials; fails_when=the middleware lets an absent or non-bearer header through; why_new=first auth middleware; seam=none; no_claim=CloudFront's own headers
  it('refuses a request without a bearer token', async () => {
    await expectUnauthenticated({});
    await expectUnauthenticated({ authorization: `Basic ${btoa('a:b')}` });
    await expectUnauthenticated({ authorization: 'Bearer' });
  });

  // Value: protects=garbage or a token signed with another key is refused; fails_when=signature verification is skipped or a parse error becomes a 500; why_new=first verifier; seam=a second issuer with the same kid, so the JWKS lookup succeeds and only the signature differs; no_claim=algorithm-confusion attacks beyond what aws-jwt-verify covers
  it('refuses a malformed token and one signed with another key', async () => {
    await expectUnauthenticated({ authorization: 'Bearer not.a.jwt' });
    const forger = new TestTokenIssuer({ kid: h.issuer.kid });
    const forged = forger.accessToken(claims(), { issuedAt: h.clock.now() });
    await expectUnauthenticated({ authorization: `Bearer ${forged}` });
  });

  // Value: protects=expiry and not-before follow the injected Clock, not the real date, so specs are stable and production checks exp; fails_when=the Clock check is removed (aws-jwt-verify's own check is off) or uses Date.now(); why_new=the library cannot take a clock; seam=FixedClock; no_claim=clock skew tolerance
  it('refuses an expired token and one not yet valid, by the Clock', async () => {
    const shortLived = sign({}, 60);
    expect((await h.call('GET', '/me', { token: shortLived })).status).toBe(200);
    h.clock.advance({ seconds: 60 });
    try {
      await expectUnauthenticated({ authorization: `Bearer ${shortLived}` });
    } finally {
      h.clock.set('2027-03-01T08:00:00.000Z');
    }
    const now = Math.floor(h.clock.now().getTime() / 1000);
    expect((await h.call('GET', '/me', { token: sign({ nbf: now }) })).status).toBe(200);
    await expectUnauthenticated({ authorization: `Bearer ${sign({ nbf: now + 300 })}` });
    await expectUnauthenticated({ authorization: `Bearer ${sign({ exp: undefined })}` });
  });

  // Value: protects=only access tokens of our own app client and issuer are accepted; fails_when=issuer, token_use or client_id is not checked, so an ID token or another app's token works; why_new=first verifier; seam=none; no_claim=Cognito's real token layout (C contract specs, WP0.10)
  it('refuses a token from another issuer, another app client, or an ID token', async () => {
    await expectUnauthenticated({ authorization: `Bearer ${sign({ iss: 'https://evil.test' })}` });
    await expectUnauthenticated({ authorization: `Bearer ${sign({ client_id: 'other-app' })}` });
    await expectUnauthenticated({
      authorization: `Bearer ${sign({ token_use: 'id', aud: TEST_CLIENT_ID })}`,
    });
  });

  // Value: protects=the claims the API trusts are well formed; fails_when=a token without role or tenant, or with a tenant that could inject `#` into a key, is accepted; why_new=first claim parsing; seam=none; no_claim=the pre-token-generation trigger (WP0.9)
  it('refuses a token whose role, tenant or subject claim is missing or malformed', async () => {
    await expectUnauthenticated({ authorization: `Bearer ${sign({ role: undefined })}` });
    await expectUnauthenticated({ authorization: `Bearer ${sign({ role: 'admin' })}` });
    await expectUnauthenticated({ authorization: `Bearer ${sign({ tenantId: 'a#b' })}` });
    await expectUnauthenticated({ authorization: `Bearer ${sign({ sub: 'not-a-uuid' })}` });
  });

  // Value: protects=the JWKS is fetched once across requests, not per request, and a token whose key is unknown is refused; fails_when=the verifier refetches on every request or accepts an unknown kid; why_new=no spec looked at the JWKS cache; seam=the issuer's in-memory fetcher; no_claim=Cognito key rotation timing (an unknown kid legitimately triggers one refetch)
  it('fetches the JWKS once across requests, and refuses a token with an unknown key id', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await h.call('GET', '/me', { token: client.token })).status).toBe(200);
    }
    expect(h.issuer.jwksRequests).toHaveLength(1);
    const stranger = new TestTokenIssuer();
    const token = stranger.accessToken(claims(), { issuedAt: h.clock.now() });
    await expectUnauthenticated({ authorization: `Bearer ${token}` });
  });
});

const BROKEN_KID = 'test-broken-jwks';

/** An issuer whose JWKS endpoint answers `reply` instead of its keys. */
class UnusableJwksIssuer extends TestTokenIssuer {
  readonly #reply: () => Promise<ArrayBuffer>;
  constructor(reply: () => Promise<ArrayBuffer>) {
    super({ kid: BROKEN_KID });
    this.#reply = reply;
  }
  override get fetcher() {
    return { fetch: this.#reply };
  }
}

const body = (text: string) => async () => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('all: a JWKS that cannot be fetched or parsed → 500 internal_error (architecture §8.2)', () => {
  // Value: protects=an outage or a broken JWKS answer does not sign every user out, and is logged; fails_when=a fetch or JWKS-validation error of aws-jwt-verify is mapped to InvalidTokenError (401); why_new=no spec covered the JWKS failure path; seam=the issuer's fetcher; no_claim=retry or caching of a failed fetch
  it.each([
    {
      name: 'unreachable',
      reply: async (): Promise<ArrayBuffer> => {
        throw new Error('connect ECONNREFUSED');
      },
    },
    { name: 'not JSON', reply: body('<html>502 Bad Gateway</html>') },
    { name: 'without a keys array', reply: body('{"keys":{}}') },
    {
      name: 'publishing the key without its modulus',
      reply: body(
        JSON.stringify({
          keys: [{ kty: 'RSA', kid: BROKEN_KID, alg: 'RS256', use: 'sig', e: 'AQAB' }],
        }),
      ),
    },
  ])('answers 500 and logs the error when the JWKS is $name', async ({ reply }) => {
    const broken = apiHarness({ issuer: new UnusableJwksIssuer(reply) });
    const res = await broken.call('GET', '/me', {
      token: broken.token(crypto.randomUUID(), 'client'),
    });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal_error');
    expect(broken.loggedErrors).toHaveLength(1);
  });
});
