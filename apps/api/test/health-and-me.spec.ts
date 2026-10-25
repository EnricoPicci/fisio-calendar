import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ClientIdSchema } from '@fisio/contracts';
import { closeTestDocumentClient, TEST_TABLE, testDocumentClient } from '@fisio/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { clientEmailGsi2, clientSk, tenantPk } from '../src/repo/keys';
import { apiHarness } from './harness';

const h = apiHarness();
afterAll(closeTestDocumentClient);

describe('GET /health (architecture §5.2)', () => {
  // Value: protects=the liveness probe answers without a token, so the smoke and CloudFront checks work before sign-in; fails_when=health is declared member, or the route is renamed; why_new=first route; seam=none; no_claim=the Lambda wiring (bundle smoke, WP0.9)
  it('answers 200 {status: ok} without a token', async () => {
    const res = await h.call('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('GET /me: the caller and their role (architecture §5.2, §8.2)', () => {
  // Value: protects=a client sees their own profile, built from their own item; fails_when=the profile is read from another key, spreads stored attributes (PK, GSI2PK, status), or drops fields; why_new=first authenticated route; seam=none; no_claim=settings in the profile (WP1.1)
  it('returns an enabled client their profile and role, and nothing else from the stored item', async () => {
    const client = await h.seedClient('enabled', { phone: '+393331234567' });
    const res = await h.call('GET', '/me', { token: client.token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      role: 'client',
      clientId: client.clientId,
      name: client.name,
      email: client.email,
      phone: '+393331234567',
      locale: 'it',
    });
  });

  // Value: protects=a client item written before WP0.6 (no channels, emailStatus or invitedAt) still reads, so existing clients keep signing in; fails_when=ClientRecordSchema loses the defaults for channels or emailStatus, and every older item fails the status check with a 500; why_new=WP0.6 adds required-with-default fields to the client item and no spec reads an item without them; seam=a raw item put with the repository's key builders; no_claim=a migration of stored items (none planned)
  it('a client item written before WP0.6 still reads, with the default channels', async () => {
    const clientId = ClientIdSchema.parse(randomUUID());
    const email = `${clientId}@example.test`;
    await testDocumentClient().send(
      new PutCommand({
        TableName: TEST_TABLE,
        Item: {
          PK: tenantPk(h.tenantId),
          SK: clientSk(clientId),
          entity: 'CLIENT',
          ...clientEmailGsi2(email),
          clientId,
          name: 'Elena Gallo',
          email,
          status: 'enabled',
          locale: 'it',
          createdAt: '2026-09-01T08:00:00.000Z',
        },
      }),
    );
    const res = await h.call('GET', '/me', { token: h.token(clientId, 'client') });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: 'client', clientId });
    expect(await h.clients.get(h.tenantId, clientId)).toMatchObject({
      channels: { email: true, whatsapp: false },
      emailStatus: 'ok',
    });
  });

  // Value: protects=the therapist is recognised by role and tenant settings; fails_when=a therapist token is looked up as a client item (403) or the role is ignored; why_new=first therapist path; seam=none; no_claim=TOTP sign-in (WP0.5)
  it('returns the therapist her role and id', async () => {
    const therapist = await h.seedTherapist();
    const res = await h.call('GET', '/me', { token: therapist.token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ role: 'therapist', therapistId: therapist.therapistId });
  });
});
