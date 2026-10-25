import { randomUUID } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { closeTestDocumentClient, TEST_TABLE, testDocumentClient } from '@fisio/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { clientSk, tenantPk } from '../src/repo/keys';
import { SettingsRepository } from '../src/repo/settings';
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

  // Value: protects=a client's token opens only their own tenant: the status check reads the client item under the token's tenant; fails_when=the client lookup ignores tenantId (a key or index on clientId alone), so a token whose tenant claim names another tenant reaches the client's profile; why_new=the erased-client spec uses an unknown sub in the same tenant, so a tenant-blind lookup still answers 403 there; seam=none; no_claim=how tenant claims are issued (pre-token-generation trigger, WP0.9)
  it('a token naming an existing client under another tenant → 403', async () => {
    const client = await h.seedClient('enabled');
    const otherTenant = apiHarness().tenantId;
    const token = h.issuer.accessToken(
      { sub: client.clientId, role: 'client', tenantId: otherTenant },
      { issuedAt: h.clock.now() },
    );
    const res = await h.call('GET', '/me', { token });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  // Value: protects=re-creating the Settings item (a bootstrap re-run) leaves the therapist's access intact, and a write that fails for another reason is not swallowed; fails_when=create rethrows ConditionalCheckFailedException (re-run crashes) or its catch swallows every error (a bootstrap against a missing table reports success); why_new=seedTherapist calls create once, on a working table; seam=none; no_claim=the bootstrap CLI itself and that existing fields survive (WP0.5, WP1.1)
  it('creating the Settings item again is a no-op, and any other write failure surfaces', async () => {
    const therapist = await h.seedTherapist();
    await expect(h.settings.create(h.tenantId, h.clock.now())).resolves.toBeUndefined();
    expect((await h.call('GET', '/me', { token: therapist.token })).status).toBe(200);
    const missingTable = new SettingsRepository(testDocumentClient(), 'fisio-no-such-table');
    await expect(missingTable.create(h.tenantId, h.clock.now())).rejects.toMatchObject({
      name: 'ResourceNotFoundException',
    });
  });

  // Value: protects=a client item that no longer matches its schema fails closed as a logged server fault, never as access and never as the caller's mistake; fails_when=ClientRepository.get stops parsing the item (a stale status passes as enabled) or the ZodError is mapped to a 4xx; why_new=no spec stored an invalid item; seam=a raw UpdateItem with keys from src/repo/keys; no_claim=migrations of the client item (WP0.6)
  it('a client item that no longer matches its schema → 500 internal_error, logged', async () => {
    const client = await h.seedClient('enabled');
    await testDocumentClient().send(
      new UpdateCommand({
        TableName: TEST_TABLE,
        Key: { PK: tenantPk(h.tenantId), SK: clientSk(client.clientId) },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'deleted' },
      }),
    );
    const logged = h.loggedErrors.length;
    const res = await h.call('GET', '/me', { token: client.token });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal_error');
    expect(h.loggedErrors).toHaveLength(logged + 1);
  });

  // Value: protects=a therapist token works only for a tenant that has been bootstrapped; fails_when=the settings check is skipped; why_new=first therapist check; seam=none; no_claim=the bootstrap CLI (WP0.5)
  it('a therapist token for a tenant without its Settings item → 403', async () => {
    const other = apiHarness();
    const res = await other.call('GET', '/me', { token: other.token(randomUUID(), 'therapist') });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });
});
