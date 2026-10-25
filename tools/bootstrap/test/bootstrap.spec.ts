import { SettingsRepository } from '@fisio/api/repo/settings';
import { createTestEmulator } from '@fisio/auth-emulator/testing';
import { TenantIdSchema } from '@fisio/contracts';
import {
  FixedClock,
  type IdentityProvider,
  type IdentityUser,
  IdentityUserExistsError,
} from '@fisio/domain';
import {
  closeTestDocumentClient,
  FakeChannel,
  freshTenant,
  TEST_TABLE,
  testDocumentClient,
} from '@fisio/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { BootstrapError, bootstrapTherapist } from '../src/bootstrap';
import { parseBootstrapArgs, runBootstrapCli } from '../src/cli';

const clock = new FixedClock('2027-03-01T08:00:00.000Z');
const tenantId = TenantIdSchema.parse(freshTenant());
const t = createTestEmulator({
  doc: testDocumentClient(),
  table: TEST_TABLE,
  clock,
  channel: new FakeChannel(),
  config: { poolId: freshTenant(), tenantId },
});
const settings = new SettingsRepository(testDocumentClient(), TEST_TABLE);
const deps = { identity: t.identity, settings, clock };
/** The emulator's provider with some methods replaced, for states the emulator cannot reach. */
const identityWith = (overrides: Partial<IdentityProvider>): IdentityProvider =>
  Object.assign(Object.create(t.identity), overrides);
const input = (email: string) => ({ email, tenantId, setupUrl: 'https://fisio.example/setup' });
/** The link's fragment fields: `email` and `code` never travel in the query string. */
const fragment = (link?: string) => new URLSearchParams(new URL(link ?? '').hash.slice(1));
const code = (link?: string) => fragment(link).get('code') ?? '';
afterAll(closeTestDocumentClient);

describe('bootstrap:therapist (architecture §11.5)', () => {
  // Value: protects=the privileged account is created complete in one run: therapist role, TOTP preferred, Settings item, a working one-time link; fails_when=any of the four is missing or the link's code does not open the setup; why_new=first bootstrap; seam=auth emulator on DynamoDB Local; no_claim=Cognito accepting the MFA preference before enrolment (WP0.10 spike)
  it('creates the therapist, sets the TOTP preference, writes settings and prints a one-time setup link', async () => {
    const result = await bootstrapTherapist(deps, input('Terapista@Example.test'));
    expect(result).toMatchObject({ email: 'terapista@example.test', created: true });
    expect(await t.identity.findUserByEmail('terapista@example.test')).toMatchObject({
      userId: result.userId,
      role: 'therapist',
      enabled: true,
      passwordSet: false,
      totp: { enabled: true, preferred: true },
    });
    expect(await settings.exists(tenantId)).toBe(true);

    const link = new URL(result.setupLink ?? '');
    expect(`${link.origin}${link.pathname}${link.search}`).toBe('https://fisio.example/setup');
    expect(fragment(result.setupLink).get('email')).toBe('terapista@example.test');
    const { tokens } = await t.completeSetup(code(result.setupLink), 'una-password-lunga');
    expect(tokens.accessToken).toBeTruthy();
  });

  // Value: protects=re-running bootstrap is safe on a live therapist: same user, TOTP preference kept, no new link that would reset the password; fails_when=a second user is created, the preference is dropped, a disabled therapist stays disabled, or a link is issued after setup; why_new=first bootstrap; seam=emulator; no_claim=concurrent runs (covered by the exists fallback, not raced here)
  it('re-run is idempotent and keeps the TOTP preference', async () => {
    const first = await bootstrapTherapist(deps, input('rerun@example.test'));
    await t.completeSetup(code(first.setupLink), 'una-password-lunga');
    await t.identity.disableUser(first.userId);

    const second = await bootstrapTherapist(deps, input('rerun@example.test'));
    expect(second).toEqual({
      userId: first.userId,
      email: 'rerun@example.test',
      created: false,
      reenabled: true,
    });
    expect(await t.identity.findUserByEmail('rerun@example.test')).toMatchObject({
      enabled: true,
      passwordSet: true,
      totp: { enabled: true, preferred: true },
    });
  });

  // Value: protects=an unfinished setup can be resumed with a fresh link that replaces the old one; fails_when=no link is printed before setup, or the old code still works; why_new=first bootstrap; seam=emulator; no_claim=Cognito temporary-password expiry
  it('before the setup is done, a re-run prints a fresh link and the earlier one stops working', async () => {
    const first = await bootstrapTherapist(deps, input('pending@example.test'));
    const second = await bootstrapTherapist(deps, input('pending@example.test'));
    expect(code(second.setupLink)).not.toBe(code(first.setupLink));
    await expect(
      t.emulator.startSetup(code(first.setupLink), 'una-password-lunga'),
    ).rejects.toMatchObject({ code: 'not_authorized' });
    await expect(
      t.emulator.startSetup(code(second.setupLink), 'una-password-lunga'),
    ).resolves.toHaveProperty('secret');
  });

  // Value: protects=a password without an enrolled authenticator is not a finished setup (Cognito with MFA optional can reach that state); fails_when=bootstrap stops issuing links once a password exists; why_new=red-team finding (WP0.5); seam=a stub port, since the emulator stores both together; no_claim=Cognito's MFA_SETUP challenge (WP0.10)
  it('keeps issuing a setup link while TOTP is not enrolled, even with a password', async () => {
    const user: IdentityUser = {
      userId: '6a1f0c7e-1d2b-4c3d-9e8f-0a1b2c3d4e5f',
      email: 'solo-password@example.test',
      role: 'therapist',
      enabled: true,
      passwordSet: true,
      totp: { enabled: true, preferred: true },
      totpEnrolled: false,
    };
    const identity = identityWith({
      findUserByEmail: async () => user,
      setTotpPreference: async () => {},
      startPasswordSetup: async () => 'codice-nuovo',
    });
    const result = await bootstrapTherapist({ ...deps, identity }, input(user.email));
    expect(code(result.setupLink)).toBe('codice-nuovo');
  });

  // Value: protects=two runs racing on a fresh pool end with one therapist; fails_when=the losing run crashes or creates a second user; why_new=testing finding (WP0.5); seam=a stub port; no_claim=the provider's own uniqueness (contract spec)
  it('a concurrent run that created the therapist first is found, not duplicated', async () => {
    const existing: IdentityUser = {
      userId: '7b2f0c7e-1d2b-4c3d-9e8f-0a1b2c3d4e5f',
      email: 'race@example.test',
      role: 'therapist',
      enabled: true,
      passwordSet: true,
      totp: { enabled: true, preferred: true },
      totpEnrolled: true,
    };
    let lookups = 0;
    const identity = identityWith({
      findUserByEmail: async () => (lookups++ === 0 ? undefined : existing),
      createUser: async (): Promise<IdentityUser> => {
        throw new IdentityUserExistsError();
      },
      setTotpPreference: async () => {},
    });
    await expect(bootstrapTherapist({ ...deps, identity }, input(existing.email))).resolves.toEqual(
      {
        userId: existing.userId,
        email: existing.email,
        created: false,
        reenabled: false,
      },
    );
  });

  // Value: protects=bootstrap never turns a client into the therapist; fails_when=a client's email is given therapist settings or MFA; why_new=first bootstrap; seam=emulator; no_claim=role changes in general
  it('refuses an email that belongs to a client', async () => {
    await t.identity.createUser({ email: 'cliente@example.test', role: 'client' });
    await expect(bootstrapTherapist(deps, input('cliente@example.test'))).rejects.toThrow(
      BootstrapError,
    );
    expect(await t.identity.findUserByEmail('cliente@example.test')).toMatchObject({
      totp: { enabled: false, preferred: false },
    });
  });

  // Value: protects=the CLI refuses a wrong stage, a missing email or an unknown option before touching any account, and needs valid cloud settings for dev/prod; fails_when=a typo reaches an adapter, or prod runs without a pool id, with a malformed one, or with a plain-http origin; why_new=first CLI; seam=none; no_claim=the cloud run (WP0.10)
  it('the CLI checks its arguments and the cloud settings before doing anything', async () => {
    expect(parseBootstrapArgs(['--stage', 'local', '--email', 'a@example.test'])).toEqual({
      stage: 'local',
      email: 'a@example.test',
    });
    for (const argv of [
      ['--stage', 'staging', '--email', 'a@example.test'],
      ['--stage', 'dev'],
      ['--stage', 'dev', '--email', 'a@example.test', '--tenant', 'main'],
      ['--stage', 'dev', '--email', 'a@example.test', '--force'],
    ]) {
      expect(parseBootstrapArgs(argv)).toHaveProperty('error');
    }
    const print = () => {};
    const prod = ['--stage', 'prod', '--email', 'a@example.test'];
    expect(await runBootstrapCli(['--stage', 'prod'], {}, print)).toBe(2);
    for (const env of [
      {},
      { COGNITO_USER_POOL_ID: 'not-a-pool', WEB_ORIGIN: 'https://fisio.example' },
      { COGNITO_USER_POOL_ID: 'eu-central-1_AbC123', WEB_ORIGIN: 'http://fisio.example' },
    ]) {
      expect(await runBootstrapCli(prod, env, print)).toBe(2);
    }
  });
});
