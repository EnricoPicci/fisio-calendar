import { randomUUID } from 'node:crypto';
import { closeTestDocumentClient } from '@fisio/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { apiHarness } from './harness';

const h = apiHarness();
afterAll(closeTestDocumentClient);

describe('T7 Manage clients: the client status is checked on every request (architecture §8.2)', () => {
  // Value: protects=blocking takes effect on the next request, not at token expiry; fails_when=the status is cached, read eventually consistent, or not checked; why_new=first status check; seam=none; no_claim=Cognito's global sign-out (WP1.x)
  it('request with a still-valid token right after blocking → 403 forbidden', async () => {
    const client = await h.seedClient('enabled');
    expect((await h.call('GET', '/me', { token: client.token })).status).toBe(200);
    const { token, ...record } = client;
    await h.clients.put(h.tenantId, { ...record, status: 'blocked' });
    const res = await h.call('GET', '/me', { token });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  // Value: protects=an invitation not yet accepted grants no access; fails_when=any status other than blocked is let through; why_new=first status check; seam=none; no_claim=how invited becomes enabled (WP0.5/WP0.6)
  it('request from a client in `invited` status → 403', async () => {
    const client = await h.seedClient('invited');
    const res = await h.call('GET', '/me', { token: client.token });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  // Value: protects=an erased client's still-valid token opens nothing; fails_when=a missing client item is treated as enabled or crashes with 500; why_new=erasure arrives in WP1.x, the check now; seam=none; no_claim=the erasure use case
  it('a token for a client with no client item (erased, or another tenant) → 403', async () => {
    const res = await h.call('GET', '/me', { token: h.token(randomUUID(), 'client') });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  // Value: protects=a therapist token works only for a tenant that has been bootstrapped; fails_when=the settings check is skipped; why_new=first therapist check; seam=none; no_claim=the bootstrap CLI (WP0.5)
  it('a therapist token for a tenant without its Settings item → 403', async () => {
    const other = apiHarness();
    const res = await other.call('GET', '/me', { token: other.token(randomUUID(), 'therapist') });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });
});
