import { randomUUID } from 'node:crypto';
import { AuthError } from '@fisio/auth-emulator';
import { createTestEmulator, otpCodeIn } from '@fisio/auth-emulator/testing';
import {
  FixedClock,
  type IdentityProvider,
  IdentityUserExistsError,
  IdentityUserNotFoundError,
} from '@fisio/domain';
import {
  closeTestDocumentClient,
  FakeChannel,
  freshTenant,
  TEST_TABLE,
  testDocumentClient,
} from '@fisio/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * IdentityProvider.contract (docs/architecture.md §10.4 group F, §11.4): one set of specs that
 * every `IdentityProvider` must pass, so the emulator stays a faithful stand-in. It runs against
 * the emulator on every `pnpm test`; WP0.10 adds the `CognitoIdentityProvider` target on the
 * `dev` pool behind `pnpm test:cloud:auth`, with a session probe built on its real sign-in.
 */
export interface ContractTarget {
  readonly provider: IdentityProvider;
  /** Signs the user in as a client device; `refresh()` says whether its session still renews. */
  signIn(email: string): Promise<{ refresh(): Promise<boolean> }>;
}

const uniqueEmail = (name: string) => `${name}-${randomUUID()}@example.test`;

export function describeIdentityProviderContract(
  name: string,
  target: () => Promise<ContractTarget>,
): void {
  describe(`IdentityProvider.contract (${name}): create / disable / delete / global sign-out behave identically`, () => {
    let t: ContractTarget;
    beforeAll(async () => {
      t = await target();
    });

    // Value: protects=a created user is found by email in any case, as a passwordless user of its role; fails_when=the lookup is case-sensitive or a field differs between adapters; why_new=first contract; seam=none; no_claim=sign-in (later rows)
    it('creates a user without a password, found by email in any letter case', async () => {
      const email = uniqueEmail('crea');
      const created = await t.provider.createUser({ email, role: 'client' });
      expect(created).toEqual({
        userId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        email,
        role: 'client',
        enabled: true,
        passwordSet: false,
        totp: { enabled: false, preferred: false },
        totpEnrolled: false,
      });
      expect(await t.provider.findUserByEmail(email.toUpperCase())).toEqual(created);
      expect(await t.provider.findUserByEmail(uniqueEmail('nessuno'))).toBeUndefined();
    });

    // Value: protects=the therapist's role and MFA preference read back the same from both adapters (the emulator stores them, Cognito derives them from groups and MFA settings); fails_when=the role is lost, or `preferred` survives a disabled preference; why_new=review finding (WP0.5); seam=none; no_claim=enrolment (sign-in specs)
    it('keeps the therapist role and the TOTP preference, preferred only while enabled', async () => {
      const email = uniqueEmail('terapista');
      const user = await t.provider.createUser({ email, role: 'therapist' });
      expect(user).toMatchObject({ role: 'therapist', totpEnrolled: false });
      await t.provider.setTotpPreference(user.userId, { enabled: true, preferred: true });
      expect((await t.provider.findUserByEmail(email))?.totp).toEqual({
        enabled: true,
        preferred: true,
      });
      await t.provider.setTotpPreference(user.userId, { enabled: false, preferred: true });
      expect((await t.provider.findUserByEmail(email))?.totp).toEqual({
        enabled: false,
        preferred: false,
      });
      expect(await t.provider.startPasswordSetup(user.userId)).toEqual(expect.any(String));
    });

    // Value: protects=the add-client 409 client_exists (WP0.6) can rely on the provider refusing a taken email; fails_when=a duplicate is created or the error is not the port's; why_new=first contract; seam=none; no_claim=the API's own uniqueness check (GSI2)
    it('refuses a second user with the same email', async () => {
      const email = uniqueEmail('doppio');
      await t.provider.createUser({ email, role: 'client' });
      await expect(
        t.provider.createUser({ email: email.toUpperCase(), role: 'client' }),
      ).rejects.toThrow(IdentityUserExistsError);
    });

    // Value: protects=blocking a client (T7) ends sign-in and refresh, unblocking restores them; fails_when=a disabled user still refreshes or enable leaves it disabled; why_new=first contract; seam=the target's sign-in probe; no_claim=the API's per-request status check
    it('a disabled user cannot renew a session; enabling lets a new sign-in through', async () => {
      const email = uniqueEmail('blocca');
      const user = await t.provider.createUser({ email, role: 'client' });
      const device = await t.signIn(email);
      // Never refreshed while disabled: only the revocation can end it.
      const idle = await t.signIn(email);
      await t.provider.disableUser(user.userId);
      await t.provider.disableUser(user.userId);
      expect(await t.provider.findUserByEmail(email)).toMatchObject({ enabled: false });
      expect(await device.refresh()).toBe(false);

      await t.provider.enableUser(user.userId);
      expect(await t.provider.findUserByEmail(email)).toMatchObject({ enabled: true });
      // Disabling revoked the old sessions for good; only a new sign-in renews.
      expect(await idle.refresh()).toBe(false);
      expect(await (await t.signIn(email)).refresh()).toBe(true);
    });

    // Value: protects=global sign-out revokes every existing refresh token but not future sign-ins; fails_when=a device keeps renewing, or the user cannot sign in again; why_new=first contract; seam=the target's sign-in probe; no_claim=access tokens already issued (they run out in 60 min)
    it('a global sign-out ends every existing session; a later sign-in works', async () => {
      const email = uniqueEmail('esci');
      const user = await t.provider.createUser({ email, role: 'client' });
      const phone = await t.signIn(email);
      const laptop = await t.signIn(email);
      await t.provider.globalSignOut(user.userId);
      expect([await phone.refresh(), await laptop.refresh()]).toEqual([false, false]);
      expect(await (await t.signIn(email)).refresh()).toBe(true);
    });

    // Value: protects=erasure (T7, §9.4) removes the identity and frees the email; fails_when=the user is still found, operations on it succeed silently, or the email stays taken; why_new=first contract; seam=none; no_claim=the application data erasure (WP3.1)
    it('a deleted user is gone: operations on it are refused and the email is free again', async () => {
      const email = uniqueEmail('cancella');
      const user = await t.provider.createUser({ email, role: 'client' });
      await t.provider.deleteUser(user.userId);
      expect(await t.provider.findUserByEmail(email)).toBeUndefined();
      for (const operation of [
        () => t.provider.disableUser(user.userId),
        () => t.provider.enableUser(user.userId),
        () => t.provider.setTotpPreference(user.userId, { enabled: true, preferred: true }),
        () => t.provider.globalSignOut(user.userId),
        () => t.provider.deleteUser(user.userId),
        () => t.provider.startPasswordSetup(user.userId),
      ]) {
        await expect(operation()).rejects.toThrow(IdentityUserNotFoundError);
      }
      await expect(t.provider.createUser({ email, role: 'client' })).resolves.toMatchObject({
        email,
      });
    });
  });
}

describeIdentityProviderContract('auth emulator on DynamoDB Local', async () => {
  const channel = new FakeChannel();
  const { emulator, identity } = createTestEmulator({
    doc: testDocumentClient(),
    table: TEST_TABLE,
    clock: new FixedClock('2027-03-01T08:00:00.000Z'),
    channel,
    config: { poolId: freshTenant(), tenantId: freshTenant() },
  });
  return {
    provider: identity,
    async signIn(email) {
      const step = await emulator.startEmailOtp(email);
      if (step.kind !== 'challenge') throw new Error('Expected the EMAIL_OTP challenge');
      let { refreshToken } = await emulator.answerEmailOtp(
        step.session,
        otpCodeIn(channel.sentTo(email).at(-1)),
      );
      return {
        async refresh() {
          try {
            ({ refreshToken } = await emulator.refresh(refreshToken));
            return true;
          } catch (error) {
            if (error instanceof AuthError) return false;
            throw error;
          }
        },
      };
    },
  };
});

afterAll(closeTestDocumentClient);
