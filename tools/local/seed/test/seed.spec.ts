import { ClientRepository } from '@fisio/api/repo/clients';
import { SettingsRepository } from '@fisio/api/repo/settings';
import { createTestEmulator } from '@fisio/auth-emulator/testing';
import { ClientIdSchema, TenantIdSchema } from '@fisio/contracts';
import { FixedClock } from '@fisio/domain';
import {
  closeTestDocumentClient,
  FakeChannel,
  freshTenant,
  TEST_TABLE,
  testDocumentClient,
} from '@fisio/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SEED_CLIENTS,
  SEED_THERAPIST_EMAIL,
  SEED_THERAPIST_PASSWORD,
  seedLocal,
} from '../src/seed';

const clock = new FixedClock('2027-03-01T08:00:00.000Z');
const tenantId = TenantIdSchema.parse(freshTenant());
const doc = testDocumentClient();
const t = createTestEmulator({
  doc,
  table: TEST_TABLE,
  clock,
  channel: new FakeChannel(),
  config: { poolId: freshTenant(), tenantId },
});
const clients = new ClientRepository(doc, TEST_TABLE);
const deps = {
  identity: t.identity,
  clients,
  settings: new SettingsRepository(doc, TEST_TABLE),
  clock,
  tenantId,
  completeSetup: t.completeSetup,
};
afterAll(closeTestDocumentClient);

describe('pnpm seed: a usable local stack in one command (architecture §11.4)', () => {
  // Value: protects=a fresh checkout gets a therapist who can sign in with the printed credentials and a dozen clients matching their identities; fails_when=the printed secret does not work, a client item's id is not its identity's sub, or a blocked client can still sign in; why_new=first seed; seam=emulator on DynamoDB Local; no_claim=rules and slots (WP1.2)
  it('seeds the therapist through bootstrap and a dozen clients', async () => {
    const report = await seedLocal(deps);
    const credentials = report.therapist.credentials;
    expect(credentials?.password).toBe(SEED_THERAPIST_PASSWORD);
    const step = await t.emulator.signInWithPassword(SEED_THERAPIST_EMAIL, SEED_THERAPIST_PASSWORD);
    if (step.kind !== 'challenge') throw new Error('Expected the TOTP challenge');
    await expect(
      t.emulator.answerTotp(step.session, await t.totp(credentials?.totpSecret ?? '')),
    ).resolves.toHaveProperty('accessToken');

    expect(SEED_CLIENTS.length).toBeGreaterThanOrEqual(12);
    for (const seed of SEED_CLIENTS) {
      const user = await t.identity.findUserByEmail(seed.email);
      expect(user?.enabled, seed.email).toBe(seed.status !== 'blocked');
      const item = await clients.get(tenantId, ClientIdSchema.parse(user?.userId));
      expect(item, seed.email).toMatchObject({ email: seed.email, status: seed.status });
    }
  });

  // Value: protects=re-running the seed is safe; fails_when=a second run duplicates users, resets the therapist's password or rewrites client items; why_new=first seed; seam=emulator; no_claim=a seed after local:down (fresh memory)
  it('a second run changes nothing', async () => {
    const before = await clients.get(
      tenantId,
      ClientIdSchema.parse(
        (await t.identity.findUserByEmail(SEED_CLIENTS[0]?.email ?? ''))?.userId,
      ),
    );
    clock.advance({ hours: 1 });
    const report = await seedLocal(deps);
    expect(report.therapist.credentials).toBeUndefined();
    const after = await clients.get(tenantId, ClientIdSchema.parse(before?.clientId));
    expect(after).toEqual(before);
  });
});
