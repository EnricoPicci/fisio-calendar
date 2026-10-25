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
    const future = Math.floor(h.clock.now().getTime() / 1000) + 300;
    await expectUnauthenticated({ authorization: `Bearer ${sign({ nbf: future })}` });
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

  // Value: protects=a token whose key is unknown is refused, and the JWKS is fetched once, not per request; fails_when=the verifier refetches on every request or accepts an unknown kid; why_new=no spec looked at the JWKS cache; seam=the issuer's in-memory fetcher; no_claim=Cognito key rotation timing
  it('refuses a token with an unknown key id, and fetches the JWKS once', async () => {
    const stranger = new TestTokenIssuer();
    const token = stranger.accessToken(claims(), { issuedAt: h.clock.now() });
    await expectUnauthenticated({ authorization: `Bearer ${token}` });
    expect(new Set(h.issuer.jwksRequests).size).toBe(1);
  });
});
