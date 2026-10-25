import { closeTestDocumentClient } from '@fisio/testkit';
import { afterAll, describe, expect, it } from 'vitest';
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

  // Value: protects=the therapist is recognised by role and tenant settings; fails_when=a therapist token is looked up as a client item (403) or the role is ignored; why_new=first therapist path; seam=none; no_claim=TOTP sign-in (WP0.5)
  it('returns the therapist her role and id', async () => {
    const therapist = await h.seedTherapist();
    const res = await h.call('GET', '/me', { token: therapist.token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ role: 'therapist', therapistId: therapist.therapistId });
  });
});
