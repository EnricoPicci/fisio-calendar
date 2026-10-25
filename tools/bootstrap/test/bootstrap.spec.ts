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
import { failureLines, parseBootstrapArgs, runBootstrapCli } from '../src/cli';

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

  // Value: protects=a password without an enrolled authenticator is not a finished setup (Cognito with MFA optional can reach that state), and the sessions it opened end; fails_when=bootstrap stops issuing links once a password exists, or skips the sign-out; why_new=red-team and security findings (WP0.5); seam=a stub port, since the emulator stores both together; no_claim=Cognito's MFA_SETUP challenge (WP0.10)
  it('keeps issuing a setup link while TOTP is not enrolled, even with a password, and signs her out', async () => {
    const user: IdentityUser = {
      userId: '6a1f0c7e-1d2b-4c3d-9e8f-0a1b2c3d4e5f',
      email: 'solo-password@example.test',
      role: 'therapist',
      enabled: true,
      passwordSet: true,
      totp: { enabled: true, preferred: true },
      totpEnrolled: false,
    };
    const calls: string[] = [];
    const identity = identityWith({
      findUserByEmail: async () => user,
      setTotpPreference: async () => {},
      globalSignOut: async () => {
        calls.push('globalSignOut');
      },
      startPasswordSetup: async () => {
        calls.push('startPasswordSetup');
        return 'codice-nuovo';
      },
    });
    const result = await bootstrapTherapist({ ...deps, identity }, input(user.email));
    expect(code(result.setupLink)).toBe('codice-nuovo');
    // Signed out after the code replaced the password, so no sign-in slips in between.
    expect(calls).toEqual(['startPasswordSetup', 'globalSignOut']);
  });

  // Value: protects=a sign-out that failed after the new code replaced the password is retried by the next run; fails_when=the sign-out is conditioned on `passwordSet`, which on Cognito the code itself clears (FORCE_CHANGE_PASSWORD); why_new=security and state-machines finding (WP0.5 ship cycle 3); seam=a stub port shaped like Cognito; no_claim=Cognito's real UserStatus (WP0.10)
  it('a sign-out that failed is retried by the next run, though the password no longer shows', async () => {
    let user: IdentityUser = {
      userId: '9d4f0c7e-1d2b-4c3d-9e8f-0a1b2c3d4e5f',
      email: 'riprova@example.test',
      role: 'therapist',
      enabled: true,
      passwordSet: true,
      totp: { enabled: true, preferred: true },
      totpEnrolled: false,
    };
    let signOuts = 0;
    const identity = identityWith({
      findUserByEmail: async () => user,
      setTotpPreference: async () => {},
      startPasswordSetup: async () => {
        user = { ...user, passwordSet: false };
        return 'codice-nuovo';
      },
      globalSignOut: async () => {
        signOuts++;
        if (signOuts === 1) throw new Error('throttled');
      },
    });
    await expect(bootstrapTherapist({ ...deps, identity }, input(user.email))).rejects.toThrow();
    const again = await bootstrapTherapist({ ...deps, identity }, input(user.email));
    expect(code(again.setupLink)).toBe('codice-nuovo');
    expect(signOuts).toBe(2);
  });

  // Value: protects=a malformed setup URL fails before any account changes, so no code is issued that no link carries; fails_when=the URL is parsed after createUser or startPasswordSetup; why_new=state-machines finding (WP0.5 ship cycle 3); seam=emulator; no_claim=the CLI's own URL checks
  it('a malformed setup URL changes no account', async () => {
    await expect(
      bootstrapTherapist(deps, { ...input('url-rotto@example.test'), setupUrl: 'non-un-url' }),
    ).rejects.toThrow();
    expect(await t.identity.findUserByEmail('url-rotto@example.test')).toBeUndefined();
  });

  // Value: protects=a therapist the first read shows as finished gets no new link, whatever the second read says; fails_when=bootstrap decides from the second read alone and replaces her password; why_new=red-team finding (WP0.5 ship cycle 3); seam=a stub port; no_claim=which read Cognito answers first
  it('a setup the first read shows as finished is left alone', async () => {
    const finished: IdentityUser = {
      userId: '0e5f0c7e-1d2b-4c3d-9e8f-0a1b2c3d4e5f',
      email: 'prima-lettura@example.test',
      role: 'therapist',
      enabled: true,
      passwordSet: true,
      totp: { enabled: true, preferred: true },
      totpEnrolled: true,
    };
    let reads = 0;
    const identity = identityWith({
      findUserByEmail: async () =>
        reads++ === 0 ? finished : { ...finished, totpEnrolled: false },
      setTotpPreference: async () => {},
      startPasswordSetup: async () => {
        throw new Error('a new setup would replace her password');
      },
    });
    const result = await bootstrapTherapist({ ...deps, identity }, input(finished.email));
    expect(result.setupLink).toBeUndefined();
  });

  // Value: protects=an enrolled therapist whose TOTP preference was off gets it back and no new link (which on Cognito would replace her password); fails_when=bootstrap decides from the read taken before it restored the preference; why_new=state-machines finding (WP0.5); seam=a stub port shaped like Cognito, where enrolment shows only while the preference is on; no_claim=Cognito's real UserMFASettingList (WP0.10 spike)
  it('an enrolled therapist with the TOTP preference off gets it back and no new link', async () => {
    let preferenceOn = false;
    const identity = identityWith({
      findUserByEmail: async () => ({
        userId: '8c3f0c7e-1d2b-4c3d-9e8f-0a1b2c3d4e5f',
        email: 'preferenza@example.test',
        role: 'therapist',
        enabled: true,
        passwordSet: true,
        totp: { enabled: preferenceOn, preferred: preferenceOn },
        totpEnrolled: preferenceOn,
      }),
      setTotpPreference: async (_, preference) => {
        preferenceOn = preference.enabled;
      },
      startPasswordSetup: async () => {
        throw new Error('a new setup would replace her password');
      },
    });
    const result = await bootstrapTherapist(
      { ...deps, identity },
      input('preferenza@example.test'),
    );
    expect(result.setupLink).toBeUndefined();
    expect(preferenceOn).toBe(true);
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

  // Value: protects=a finished, enabled therapist's re-run leaves her password and account alone; fails_when=a re-run issues a link (on Cognito a new temporary password) or changes the user; why_new=state-machines finding (WP0.5): only the disabled variant was specced; seam=emulator; no_claim=Cognito's preference list (stub row above)
  it('a finished, enabled therapist gets no link and keeps her password', async () => {
    const first = await bootstrapTherapist(deps, input('fatto@example.test'));
    await t.completeSetup(code(first.setupLink), 'una-password-lunga');
    const again = await bootstrapTherapist(deps, input('fatto@example.test'));
    expect(again).toEqual({
      userId: first.userId,
      email: 'fatto@example.test',
      created: false,
      reenabled: false,
    });
    clock.advance({ seconds: 30 });
    await expect(
      t.emulator.signInWithPassword('fatto@example.test', 'una-password-lunga'),
    ).resolves.toMatchObject({ kind: 'challenge' });
  });

  // Value: protects=a disabled therapist who never finished setup is re-enabled and gets a link that works; fails_when=the re-enable is skipped or the fresh code does not open a setup; why_new=state-machines finding (WP0.5); seam=emulator; no_claim=none beyond protects
  it('a disabled therapist who never finished setup is re-enabled and gets a working link', async () => {
    const first = await bootstrapTherapist(deps, input('ferma@example.test'));
    await t.identity.disableUser(first.userId);
    const again = await bootstrapTherapist(deps, input('ferma@example.test'));
    expect(again).toMatchObject({ reenabled: true, setupLink: expect.any(String) });
    await expect(
      t.emulator.startSetup(code(again.setupLink), 'una-password-lunga'),
    ).resolves.toHaveProperty('secret');
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

  // Value: protects=a failed run names every cause, so the operator of the WP0.10 cloud bootstrap can act on both Cognito failures; fails_when=the CLI prints only the AggregateError's summary, or drops an error's name; why_new=review finding (run 2 cycle 2); seam=failureLines, the CLI's failure output; no_claim=the message wording
  it('a failed run prints each cause of an aggregate failure by name', () => {
    const named = (name: string) => Object.assign(new Error(name), { name });
    const lines = failureLines(
      new AggregateError([named('TooManyRequestsException'), named('AccessDeniedException')], ''),
    );
    expect(lines.map((line) => line.match(/\b\w+(?:Error|Exception)\b/)?.[0])).toEqual([
      'AggregateError',
      'TooManyRequestsException',
      'AccessDeniedException',
    ]);
    expect(failureLines(named('ResourceNotFoundException'))).toHaveLength(1);
  });
});
