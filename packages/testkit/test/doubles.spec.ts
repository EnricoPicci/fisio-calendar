import { PermanentError } from '@fisio/domain';
import { describe, expect, it } from 'vitest';
import { FakeChannel, inProcessFetch, TestTokenIssuer } from '../src/index';

const message = {
  channel: 'email' as const,
  notificationKey: 'INVITE#c1#1',
  to: 'giulia@example.test',
  subject: 'Invito',
  text: 'Ciao',
};

describe('testkit doubles for API specs (architecture §10.1)', () => {
  // Value: protects=specs can assert what was sent and force provider failures in order; fails_when=a failed send is recorded as sent, or failures are not consumed one per call; why_new=first FakeChannel; seam=none; no_claim=the real channels (contract specs, WP0.6)
  it('FakeChannel records accepted messages and throws the queued failures first', async () => {
    const channel = new FakeChannel();
    channel.failNext(new PermanentError('bad address'));
    await expect(channel.send(message)).rejects.toThrow(PermanentError);
    await expect(channel.send(message)).resolves.toEqual({ providerMessageId: 'fake-1' });
    expect(channel.sentTo('giulia@example.test')).toEqual([message]);
  });

  // Value: protects=relative URLs and Request objects both reach the app with method, headers and body intact; fails_when=the adapter drops init or mangles the path; why_new=first adapter (used by the SPA ApiClient from WP0.7); seam=a recording app; no_claim=Hono's own request handling
  it('inProcessFetch hands the app a Request built from a relative URL or a Request', async () => {
    const seen: string[] = [];
    const fetch = inProcessFetch({
      request: async (req) => {
        seen.push(`${req.method} ${new URL(req.url).pathname} ${await req.text()}`);
        return new Response('ok');
      },
    });
    await fetch('/api/v1/me', { method: 'POST', body: 'a' });
    await fetch(new Request('http://x.test/api/v1/health'));
    expect(seen).toEqual(['POST /api/v1/me a', 'GET /api/v1/health ']);
  });

  // Value: protects=the fake tokens carry Cognito's access-token claims and the issuer's kid, so the real verifier accepts them; fails_when=a standard claim is renamed or the kid in the header differs from the JWKS; why_new=first issuer; seam=none; no_claim=signature validity (API authentication spec)
  it('TestTokenIssuer signs Cognito-shaped access tokens whose kid is in its JWKS', () => {
    const issuer = new TestTokenIssuer();
    const token = issuer.accessToken(
      { sub: 's', role: 'client', tenantId: 't' },
      { issuedAt: new Date('2027-03-01T08:00:00Z'), override: { scope: undefined } },
    );
    const [header, payload] = token
      .split('.')
      .slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()));
    expect(header).toMatchObject({ alg: 'RS256', kid: issuer.kid });
    expect(issuer.jwks.keys.map((key) => key.kid)).toEqual([issuer.kid]);
    expect(payload).toMatchObject({
      token_use: 'access',
      client_id: issuer.clientId,
      iss: issuer.issuer,
      iat: 1_803_888_000,
      exp: 1_803_891_600,
    });
    expect(payload).not.toHaveProperty('scope');
  });
});
