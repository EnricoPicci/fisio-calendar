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
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AuthError } from './auth-service';
import { LOCAL_TOKENS_KEY, LocalAuthService } from './local-auth-service';
import { NetworkError } from './network-error';
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
const service = (storage = new MemoryStorage(), fetchWith = fetch) => ({
  storage,
  auth: new LocalAuthService({ issuer: t.config.issuer, fetch: fetchWith, storage }),
});
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

/** A signed-in client with a usable refresh token in `storage`. */
async function signedInClient() {
  const anna = await client();
  const { auth, storage } = service();
  await firstValueFrom(auth.requestCode(anna.email));
  const tokens = await firstValueFrom(auth.confirmCode(lastCode(anna.email)));
  return { anna, auth, storage, tokens };
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

  it('therapist without TOTP enabled: signInWithPassword() signs in at once and keeps the tokens on the device', async () => {
    const user = await t.identity.createUser({ email: email('senza-totp'), role: 'therapist' });
    const setupCode = await t.identity.startPasswordSetup(user.userId);
    await t.completeSetup(setupCode, PASSWORD);
    await t.identity.setTotpPreference(user.userId, { enabled: false, preferred: false });
    clock.advance({ seconds: 30 });
    const { auth, storage } = service();

    const step = await firstValueFrom(auth.signInWithPassword(user.email, PASSWORD));

    expect(step.kind).toBe('signed_in');
    if (step.kind !== 'signed_in') return;
    expect(jwtPayload(step.tokens.accessToken)).toMatchObject({
      sub: user.userId,
      role: 'therapist',
    });
    expect(storage.get(LOCAL_TOKENS_KEY)).toContain('refreshToken');
    await expect(firstValueFrom(auth.restore())).resolves.toEqual(step.tokens);
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
    const { auth, tokens: first } = await signedInClient();
    clock.advance({ minutes: 1 });

    const refreshed = await firstValueFrom(auth.refresh());
    expect(refreshed.accessToken).not.toBe(first.accessToken);
    await expect(firstValueFrom(auth.restore())).resolves.toEqual(refreshed);

    await firstValueFrom(auth.signOut());
    await expect(firstValueFrom(auth.restore())).resolves.toBeNull();
    await expect(refused(firstValueFrom(auth.refresh()))).resolves.toBe('not_authorized');
  });

  it('refresh() after a global sign-out is refused and the device forgets the tokens', async () => {
    const { anna, auth } = await signedInClient();
    await t.identity.globalSignOut(anna.userId);

    await expect(refused(firstValueFrom(auth.refresh()))).resolves.toBe('not_authorized');
    await expect(firstValueFrom(auth.restore())).resolves.toBeNull();
  });

  it('a refresh unsubscribed mid-flight still keeps the rotated tokens (the old one is spent)', async () => {
    const { auth, storage, tokens: first } = await signedInClient();
    clock.advance({ minutes: 1 });

    const subscription = auth.refresh().subscribe();
    subscription.unsubscribe();
    // The round trip is in-process and detached from the subscription: wait for its effect.
    await vi.waitFor(() => expect(storage.get(LOCAL_TOKENS_KEY)).not.toContain(first.accessToken));

    const kept = await firstValueFrom(auth.restore());
    expect(kept?.accessToken).not.toBe(first.accessToken);
    expect(storage.get(LOCAL_TOKENS_KEY)).toContain(kept?.accessToken);
    await expect(firstValueFrom(auth.refresh())).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
  });

  it('a signOut() while a refresh is in flight wins: the device stays signed out', async () => {
    const { auth, storage } = await signedInClient();
    clock.advance({ minutes: 1 });

    const pending = refused(firstValueFrom(auth.refresh()));
    await firstValueFrom(auth.signOut());

    await expect(pending).resolves.toBe('not_authorized');
    expect(storage.get(LOCAL_TOKENS_KEY)).toBeNull();
    await expect(firstValueFrom(auth.restore())).resolves.toBeNull();
  });

  it('two tabs refreshing at once (shared storage): both end up with the one rotated pair, nothing is lost', async () => {
    const { auth: tabA, storage } = await signedInClient();
    const tabB = new LocalAuthService({ issuer: t.config.issuer, fetch, storage });
    clock.advance({ minutes: 1 });

    const settled = await Promise.allSettled([
      firstValueFrom(tabA.refresh()),
      firstValueFrom(tabB.refresh()),
    ]);

    // The emulator spends the token once: one tab wins, the other may be refused (and its
    // session ends until the page reloads), but the winner's pair survives in storage.
    const winners = settled.filter((r) => r.status === 'fulfilled');
    expect(winners.length).toBeGreaterThanOrEqual(1);
    const kept = storage.get(LOCAL_TOKENS_KEY);
    expect(kept).not.toBeNull();
    for (const w of winners) expect(kept).toContain(w.value.accessToken);
    // The surviving pair is live: a reload restores it and the next refresh works.
    const reloaded = new LocalAuthService({ issuer: t.config.issuer, fetch, storage });
    await expect(firstValueFrom(reloaded.restore())).resolves.not.toBeNull();
    await expect(firstValueFrom(reloaded.refresh())).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
  });

  it('a signOut() in another tab while this tab refreshes wins: the rotated pair is not written back', async () => {
    const { auth: tabA, storage } = await signedInClient();
    const tabB = new LocalAuthService({ issuer: t.config.issuer, fetch, storage });
    clock.advance({ minutes: 1 });

    const pending = refused(firstValueFrom(tabA.refresh()));
    await firstValueFrom(tabB.signOut());

    await expect(pending).resolves.toBe('not_authorized');
    expect(storage.get(LOCAL_TOKENS_KEY)).toBeNull();
    await expect(firstValueFrom(tabA.restore())).resolves.toBeNull();
  });

  it('a refresh refused after another tab signed out leaves the storage empty', async () => {
    const { anna, auth: tabA, storage } = await signedInClient();
    const tabB = new LocalAuthService({ issuer: t.config.issuer, fetch, storage });
    await t.identity.globalSignOut(anna.userId);

    const pending = refused(firstValueFrom(tabA.refresh()));
    await firstValueFrom(tabB.signOut());

    await expect(pending).resolves.toBe('not_authorized');
    expect(storage.get(LOCAL_TOKENS_KEY)).toBeNull();
  });

  it('a signOut() while a refresh the emulator then refuses is in flight: not_authorized, storage empty', async () => {
    const { anna, auth, storage } = await signedInClient();
    await t.identity.globalSignOut(anna.userId);

    const pending = refused(firstValueFrom(auth.refresh()));
    await firstValueFrom(auth.signOut());

    await expect(pending).resolves.toBe('not_authorized');
    expect(storage.get(LOCAL_TOKENS_KEY)).toBeNull();
  });

  it('a refused refresh leaves a spent marker naming the dead token, which restore() reads as nobody', async () => {
    const { anna, auth, storage } = await signedInClient();
    const before = JSON.parse(storage.get(LOCAL_TOKENS_KEY) ?? '{}') as { refreshToken: string };
    await t.identity.globalSignOut(anna.userId);

    await expect(refused(firstValueFrom(auth.refresh()))).resolves.toBe('not_authorized');

    expect(JSON.parse(storage.get(LOCAL_TOKENS_KEY) ?? '')).toEqual({ spent: before.refreshToken });
    await expect(firstValueFrom(auth.restore())).resolves.toBeNull();
  });

  it('two tabs refreshing a revoked pair: both refused, the marker stays, restore() is nobody', async () => {
    const { anna, auth: tabA, storage } = await signedInClient();
    const tabB = new LocalAuthService({ issuer: t.config.issuer, fetch, storage });
    await t.identity.globalSignOut(anna.userId);

    await expect(refused(firstValueFrom(tabA.refresh()))).resolves.toBe('not_authorized');
    await expect(refused(firstValueFrom(tabB.refresh()))).resolves.toBe('not_authorized');

    expect(JSON.parse(storage.get(LOCAL_TOKENS_KEY) ?? '')).toHaveProperty('spent');
    await expect(firstValueFrom(tabB.restore())).resolves.toBeNull();
  });

  it('a refresh that wins after the losing tab left its spent marker keeps the rotated pair', async () => {
    const { auth: tabA, storage, tokens: first } = await signedInClient();
    clock.advance({ minutes: 1 });
    // The losing tab finished first: refused, it replaced the pair with the marker before this
    // tab's answer arrived.
    const loserFirst: typeof globalThis.fetch = async (...args) => {
      const response = await fetch(...args);
      storage.set(LOCAL_TOKENS_KEY, JSON.stringify({ spent: 'the-refresh-token-both-tabs-used' }));
      return response;
    };
    const winner = new LocalAuthService({ issuer: t.config.issuer, fetch: loserFirst, storage });

    const kept = await firstValueFrom(winner.refresh());

    expect(kept.accessToken).not.toBe(first.accessToken);
    expect(storage.get(LOCAL_TOKENS_KEY)).toContain(kept.accessToken);
    await expect(firstValueFrom(tabA.restore())).resolves.toEqual(kept);
    await expect(firstValueFrom(tabA.refresh())).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
  });

  it('a refresh that lands after another tab rotated the pair adopts the stored pair and writes nothing', async () => {
    const { auth: tabA, storage } = await signedInClient();
    clock.advance({ minutes: 1 });
    // The other tab's rotation landed first: its pair is in storage when this answer arrives.
    // Short fixture values: the pre-gate's secret scanner reads long token-named literals as keys.
    const rotatedMeanwhile = JSON.stringify({
      accessToken: 'a2',
      idToken: 'i2',
      refreshToken: 'r2',
    });
    const otherFirst: typeof globalThis.fetch = async (...args) => {
      const response = await fetch(...args);
      storage.set(LOCAL_TOKENS_KEY, rotatedMeanwhile);
      return response;
    };
    const late = new LocalAuthService({ issuer: t.config.issuer, fetch: otherFirst, storage });

    await expect(firstValueFrom(late.refresh())).resolves.toEqual({
      accessToken: 'a2',
      idToken: 'i2',
    });

    expect(storage.get(LOCAL_TOKENS_KEY)).toBe(rotatedMeanwhile);
    await expect(firstValueFrom(tabA.restore())).resolves.toEqual({
      accessToken: 'a2',
      idToken: 'i2',
    });
  });

  it('setup link: five wrong first codes lock the enrolment; the session is gone afterwards', async () => {
    const user = await t.identity.createUser({ email: email('bloccata'), role: 'therapist' });
    const code = await t.identity.startPasswordSetup(user.userId);
    const { auth } = service();
    await firstValueFrom(auth.startSetup({ email: user.email, code, password: PASSWORD }));
    for (let i = 0; i < 4; i++) {
      await expect(refused(firstValueFrom(auth.verifyTotpSetup('000000')))).resolves.toBe(
        'code_mismatch',
      );
    }
    await expect(refused(firstValueFrom(auth.verifyTotpSetup('000000')))).resolves.toBe(
      'too_many_attempts',
    );
    // The lockout ended the enrolment session: the secret on screen is dead from here on.
    await expect(refused(firstValueFrom(auth.verifyTotpSetup('000000')))).resolves.toBe(
      'invalid_session',
    );
  });

  it.each([
    'not json',
    '{"accessToken":"a","idToken":"b"}',
    '{}',
    '"str"',
    '{"accessToken":"","idToken":"b","refreshToken":"c"}',
    '{"spent":"a-refresh-token-the-emulator-refused"}',
  ])(
    'corrupt storage %j: restore() is nobody and refresh() is not_authorized without a request',
    async (raw) => {
      const calls: unknown[] = [];
      const counting: typeof globalThis.fetch = async (...args) => {
        calls.push(args);
        return fetch(...args);
      };
      const storage = new MemoryStorage();
      storage.set(LOCAL_TOKENS_KEY, raw);
      const { auth } = service(storage, counting);
      await expect(firstValueFrom(auth.restore())).resolves.toBeNull();
      await expect(refused(firstValueFrom(auth.refresh()))).resolves.toBe('not_authorized');
      expect(calls).toHaveLength(0);
    },
  );

  it('a request that never reaches the emulator is a NetworkError, not a refusal', async () => {
    const offline: typeof globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const { auth } = service(new MemoryStorage(), offline);
    const failure = await refused(firstValueFrom(auth.requestCode('x@example.test')));
    expect(failure).toBeInstanceOf(NetworkError);
  });

  it('an answer outside the sign-in codes, or a 200 with an unexpected body, is unexpected (not an AuthError)', async () => {
    const answer =
      (status: number, body: unknown): typeof globalThis.fetch =>
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
    for (const broken of [answer(500, { code: 'internal_error' }), answer(200, { kind: 'nope' })]) {
      const { auth } = service(new MemoryStorage(), broken);
      const failure = await refused(firstValueFrom(auth.requestCode('x@example.test')));
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(AuthError);
      expect(failure).not.toBeInstanceOf(NetworkError);
    }
  });
});
