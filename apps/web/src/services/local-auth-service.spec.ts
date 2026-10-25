import { createEmulatorApp } from '@fisio/auth-emulator';
import { createTestEmulator, jwtPayload, otpCodeIn, totpCode } from '@fisio/auth-emulator/testing';
import { FixedClock } from '@fisio/domain';
import {
  closeTestDocumentClient,
  FakeChannel,
  freshTenant,
  inProcessFetch,
  TEST_TABLE,
  testDocumentClient,
} from '@fisio/testkit';
import { firstValueFrom } from 'rxjs';
import { afterAll, describe, expect, it } from 'vitest';
import { AuthError } from './auth-service';
import { LOCAL_TOKENS_KEY, LocalAuthService } from './local-auth-service';
import { MemoryStorage } from './storage';

/**
 * The local `AuthService` against the real emulator app in-process (architecture §11.4): the
 * routes `pnpm dev` serves, DynamoDB Local behind them, one-time codes read back from
 * `FakeChannel`. The same composition carries the headless journeys (WP0.8).
 */
const SPEC_NOW = '2027-03-01T08:00:00.000Z';
const PASSWORD = 'password-of-twelve';

const clock = new FixedClock(SPEC_NOW);
const channel = new FakeChannel();
const t = createTestEmulator({
  doc: testDocumentClient(),
  table: TEST_TABLE,
  clock,
  channel,
  config: { poolId: freshTenant(), tenantId: freshTenant() },
});
const app = createEmulatorApp(t.emulator, t.config);
const fetch = inProcessFetch(app);

let next = 0;
const email = (name: string) => `${name}-${++next}@example.test`;
const lastCode = (to: string) => otpCodeIn(channel.sentTo(to).at(-1));
const service = () => {
  const storage = new MemoryStorage();
  return { storage, auth: new LocalAuthService({ issuer: t.config.issuer, fetch, storage }) };
};
const refused = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof AuthError ? error.code : error),
  );

async function client(name = 'giulia') {
  return t.identity.createUser({ email: email(name), role: 'client' });
}

/** A therapist as the bootstrap CLI leaves one, after the setup link was used. */
async function therapist() {
  const user = await t.identity.createUser({ email: email('terapista'), role: 'therapist' });
  await t.identity.setTotpPreference(user.userId, { enabled: true, preferred: true });
  const setupCode = await t.identity.startPasswordSetup(user.userId);
  const { secret } = await t.completeSetup(setupCode, PASSWORD);
  clock.advance({ seconds: 30 });
  return { ...user, secret };
}

afterAll(async () => {
  await closeTestDocumentClient();
});

describe('LocalAuthService: the SPA sign-in flows against the auth emulator (architecture §11.4)', () => {
  it('client: requestCode() sends the code by email; confirmCode() signs in and keeps the tokens', async () => {
    const anna = await client();
    const { auth, storage } = service();

    await firstValueFrom(auth.requestCode(anna.email));
    const tokens = await firstValueFrom(auth.confirmCode(lastCode(anna.email)));

    expect(jwtPayload(tokens.accessToken)).toMatchObject({ sub: anna.userId, role: 'client' });
    expect(jwtPayload(tokens.idToken)).toMatchObject({ email: anna.email });
    expect(storage.get(LOCAL_TOKENS_KEY)).toContain('refreshToken');
    await expect(firstValueFrom(auth.restore())).resolves.toEqual(tokens);
  });

  it('wrong code: code_mismatch, and the right code still works afterwards', async () => {
    const anna = await client();
    const { auth } = service();
    await firstValueFrom(auth.requestCode(anna.email));

    await expect(refused(firstValueFrom(auth.confirmCode('00000000')))).resolves.toBe(
      'code_mismatch',
    );
    await expect(firstValueFrom(auth.confirmCode(lastCode(anna.email)))).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
  });

  it('five wrong codes: too_many_attempts', async () => {
    const anna = await client();
    const { auth } = service();
    await firstValueFrom(auth.requestCode(anna.email));
    for (let i = 0; i < 4; i++) {
      await expect(refused(firstValueFrom(auth.confirmCode('00000000')))).resolves.toBe(
        'code_mismatch',
      );
    }
    await expect(refused(firstValueFrom(auth.confirmCode('00000000')))).resolves.toBe(
      'too_many_attempts',
    );
  });

  it('unknown email: requestCode() answers like any other, no email goes out, the code step fails as a wrong code', async () => {
    const { auth } = service();
    const stranger = email('nobody');
    await expect(firstValueFrom(auth.requestCode(stranger))).resolves.toBeUndefined();
    expect(channel.sentTo(stranger)).toHaveLength(0);
    await expect(refused(firstValueFrom(auth.confirmCode('12345678')))).resolves.toBe(
      'code_mismatch',
    );
  });

  it('confirmCode() without a requestCode() first: invalid_session', async () => {
    const { auth } = service();
    await expect(refused(firstValueFrom(auth.confirmCode('12345678')))).resolves.toBe(
      'invalid_session',
    );
  });

  it('therapist: signInWithPassword() asks for the TOTP code; confirmTotp() signs in', async () => {
    const her = await therapist();
    const { auth } = service();

    await expect(firstValueFrom(auth.signInWithPassword(her.email, PASSWORD))).resolves.toEqual({
      kind: 'totp_required',
    });
    const tokens = await firstValueFrom(auth.confirmTotp(await totpCode(clock, her.secret)));

    expect(jwtPayload(tokens.accessToken)).toMatchObject({ role: 'therapist' });
  });

  it('therapist: a wrong password is not_authorized; a wrong TOTP code is code_mismatch', async () => {
    const her = await therapist();
    const { auth } = service();
    await expect(
      refused(firstValueFrom(auth.signInWithPassword(her.email, 'wrong'))),
    ).resolves.toBe('not_authorized');
    await firstValueFrom(auth.signInWithPassword(her.email, PASSWORD));
    await expect(refused(firstValueFrom(auth.confirmTotp('000000')))).resolves.toBe(
      'code_mismatch',
    );
  });

  it('setup link: startSetup() returns the secret; verifyTotpSetup() with its first code signs in', async () => {
    const user = await t.identity.createUser({ email: email('nuova'), role: 'therapist' });
    await t.identity.setTotpPreference(user.userId, { enabled: true, preferred: true });
    const code = await t.identity.startPasswordSetup(user.userId);
    const { auth } = service();

    const enrolment = await firstValueFrom(
      auth.startSetup({ email: user.email, code, password: PASSWORD }),
    );
    expect(enrolment.otpauthUri).toContain(enrolment.secret);
    const tokens = await firstValueFrom(
      auth.verifyTotpSetup(await totpCode(clock, enrolment.secret)),
    );

    expect(jwtPayload(tokens.accessToken)).toMatchObject({ sub: user.userId, role: 'therapist' });
    await expect(
      refused(firstValueFrom(auth.startSetup({ email: user.email, code, password: PASSWORD }))),
    ).resolves.toBe('not_authorized');
  });

  it('setup link: a password shorter than the policy is invalid_password', async () => {
    const user = await t.identity.createUser({ email: email('corta'), role: 'therapist' });
    const code = await t.identity.startPasswordSetup(user.userId);
    const { auth } = service();
    await expect(
      refused(firstValueFrom(auth.startSetup({ email: user.email, code, password: 'short' }))),
    ).resolves.toBe('invalid_password');
  });

  it('refresh() rotates the tokens on the device; after signOut() there is nothing to refresh', async () => {
    const anna = await client();
    const { auth } = service();
    await firstValueFrom(auth.requestCode(anna.email));
    const first = await firstValueFrom(auth.confirmCode(lastCode(anna.email)));
    clock.advance({ minutes: 1 });

    const refreshed = await firstValueFrom(auth.refresh());
    expect(refreshed.accessToken).not.toBe(first.accessToken);
    await expect(firstValueFrom(auth.restore())).resolves.toEqual(refreshed);

    await firstValueFrom(auth.signOut());
    await expect(firstValueFrom(auth.restore())).resolves.toBeNull();
    await expect(refused(firstValueFrom(auth.refresh()))).resolves.toBe('not_authorized');
  });

  it('refresh() after a global sign-out is refused and the device forgets the tokens', async () => {
    const anna = await client();
    const { auth } = service();
    await firstValueFrom(auth.requestCode(anna.email));
    await firstValueFrom(auth.confirmCode(lastCode(anna.email)));
    await t.identity.globalSignOut(anna.userId);

    await expect(refused(firstValueFrom(auth.refresh()))).resolves.toBe('not_authorized');
    await expect(firstValueFrom(auth.restore())).resolves.toBeNull();
  });

  it('an answer outside the sign-in codes is unexpected, not an AuthError', async () => {
    const broken: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 'internal_error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    const auth = new LocalAuthService({
      issuer: t.config.issuer,
      fetch: broken,
      storage: new MemoryStorage(),
    });
    const failure = await refused(firstValueFrom(auth.requestCode('x@example.test')));
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AuthError);
  });
});
