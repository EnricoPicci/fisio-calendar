import {
  closeTestDocumentClient,
  freshTenant,
  TEST_TABLE,
  testDocumentClient,
} from '@fisio/testkit';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthError, type SignInStep } from '../src/emulator';
import { sha256 } from '../src/secrets';
import { createTestEmulator, jwtPayload } from '../src/testing';
import { emulatorHarness, SPEC_NOW, THERAPIST_PASSWORD } from './harness';

const h = emulatorHarness();
afterAll(closeTestDocumentClient);
// Every spec starts at the same instant, whatever the others did to the clock.
beforeEach(() => h.clock.set(SPEC_NOW));

/** The auth error code a sign-in step was refused with. */
async function refusal(step: Promise<unknown>): Promise<string> {
  const error = await step.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof AuthError)) throw new Error(`Expected an AuthError, got ${String(error)}`);
  return error.code;
}

/** The password hash and TOTP secret stored on a user: both absent until an enrolment succeeds. */
async function storedSecrets(userId: string): Promise<[string | undefined, string | undefined]> {
  const user = await h.store.getUser(userId);
  return [user?.passwordHash, user?.totpSecret];
}

function sessionOf(step: SignInStep): string {
  if (step.kind !== 'challenge') throw new Error('Expected a challenge');
  return step.session;
}

describe('C1 Sign in without a password (local auth emulator)', () => {
  // Value: protects=the passwordless client flow ends in Cognito-shaped tokens the API accepts; fails_when=no code is sent, the code is not accepted, or a claim the API verifies is missing; why_new=first emulator; seam=FakeChannel for the email; no_claim=Cognito's own flow (cloud contract, WP0.10)
  it('enters email, receives a one-time code, enters it and is signed in', async () => {
    const user = await h.client();
    const step = await h.emulator.startEmailOtp(user.email.toUpperCase());
    expect(step).toEqual({
      kind: 'challenge',
      challenge: 'EMAIL_OTP',
      session: expect.any(String),
    });
    expect(h.lastCode(user.email)).toMatch(/^\d{8}$/);

    const tokens = await h.emulator.answerEmailOtp(sessionOf(step), h.lastCode(user.email));
    expect(tokens.expiresIn).toBe(3600);
    expect(jwtPayload(tokens.accessToken)).toMatchObject({
      sub: user.userId,
      token_use: 'access',
      client_id: h.config.clientId,
      iss: h.config.issuer,
      role: 'client',
      tenantId: h.config.tenantId,
      'cognito:groups': ['client'],
    });
    expect(jwtPayload(tokens.idToken)).toMatchObject({ token_use: 'id', email: user.email });
    // The code is spent with the session.
    expect(await refusal(h.emulator.answerEmailOtp(sessionOf(step), h.lastCode(user.email)))).toBe(
      'invalid_session',
    );
  });

  // Value: protects=the 30-day device session and refresh-token rotation; fails_when=refresh tokens are reusable, outlive 30 days, or rotation resets the expiry; why_new=first refresh; seam=FixedClock; no_claim=Cognito's rotation grace period
  it('stays signed in on the device for 30 days', async () => {
    const user = await h.client();
    const session = sessionOf(await h.emulator.startEmailOtp(user.email));
    const first = await h.emulator.answerEmailOtp(session, h.lastCode(user.email));

    h.clock.advance({ days: 29 });
    const second = await h.emulator.refresh(first.refreshToken);
    expect(jwtPayload(second.accessToken)).toMatchObject({ sub: user.userId });
    expect(await refusal(h.emulator.refresh(first.refreshToken))).toBe('not_authorized');

    h.clock.advance({ days: 1 });
    expect(await refusal(h.emulator.refresh(second.refreshToken))).toBe('not_authorized');
  });

  // Value: protects=no account enumeration on the code flow; fails_when=an unknown, blocked or therapist email gets a different answer, an email, or a different error; why_new=first emulator; seam=FakeChannel; no_claim=response timing
  it('an unknown or blocked email is refused without revealing whether it exists', async () => {
    const known = await h.client();
    const blocked = await h.client();
    await h.identity.disableUser(blocked.userId);
    const therapist = await h.therapist();
    const sentBefore = h.channel.sent.length;

    const steps = await Promise.all(
      [known.email, blocked.email, 'nessuno@example.test', therapist.email].map((email) =>
        h.emulator.startEmailOtp(email),
      ),
    );
    const shape = (step: SignInStep) => ({ ...step, session: typeof sessionOf(step) });
    expect(new Set(steps.map((step) => JSON.stringify(shape(step)))).size).toBe(1);
    expect(h.channel.sent.slice(sentBefore).map((message) => message.to)).toEqual([known.email]);

    const answers = await Promise.all(
      steps.slice(1).map((step) => refusal(h.emulator.answerEmailOtp(sessionOf(step), '12345678'))),
    );
    expect(answers).toEqual(['code_mismatch', 'code_mismatch', 'code_mismatch']);
  });

  // Value: protects=a mistyped code is refused and the right one still works; fails_when=any code is accepted, or one wrong try ends the session; why_new=first emulator; seam=none; no_claim=lockout (next spec)
  it('a wrong code is refused', async () => {
    const user = await h.client();
    const session = sessionOf(await h.emulator.startEmailOtp(user.email));
    expect(await refusal(h.emulator.answerEmailOtp(session, h.wrongCode(user.email)))).toBe(
      'code_mismatch',
    );
    await expect(
      h.emulator.answerEmailOtp(session, h.lastCode(user.email)),
    ).resolves.toHaveProperty('accessToken');
  });

  // Value: protects=brute force on the 8-digit code is capped; fails_when=the 5th wrong code is not a lockout, a new code works during it, or the lock never ends; why_new=first emulator; seam=FixedClock; no_claim=Cognito's exact thresholds
  it('five wrong codes lock the attempt temporarily', async () => {
    const user = await h.client();
    const session = sessionOf(await h.emulator.startEmailOtp(user.email));
    const wrong = h.wrongCode(user.email);
    const answers: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      answers.push(await refusal(h.emulator.answerEmailOtp(session, wrong)));
    }
    expect(answers).toEqual([...Array(4).fill('code_mismatch'), 'too_many_attempts']);

    // Locked: a new code is not even sent, and answering gives the lockout again.
    const sent = h.channel.sentTo(user.email).length;
    const during = sessionOf(await h.emulator.startEmailOtp(user.email));
    expect(h.channel.sentTo(user.email)).toHaveLength(sent);
    expect(await refusal(h.emulator.answerEmailOtp(during, '00000000'))).toBe('too_many_attempts');

    h.clock.advance({ minutes: 15 });
    // The locked session was ended, not just left to expire (that would be code_expired).
    expect(await refusal(h.emulator.answerEmailOtp(session, wrong))).toBe('invalid_session');
    const after = sessionOf(await h.emulator.startEmailOtp(user.email));
    await expect(h.emulator.answerEmailOtp(after, h.lastCode(user.email))).resolves.toHaveProperty(
      'accessToken',
    );
  });

  // Value: protects=the lockout counts guesses, not a client's scattered typos; fails_when=a successful sign-in or the end of the 15-minute window does not reset the count; why_new=review finding (WP0.5); seam=FixedClock; no_claim=Cognito's own counter
  it('a successful sign-in, or 15 minutes without errors, resets the wrong-code count', async () => {
    const user = await h.client();
    const fourWrong = async () => {
      const session = sessionOf(await h.emulator.startEmailOtp(user.email));
      const answers: string[] = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        answers.push(await refusal(h.emulator.answerEmailOtp(session, h.wrongCode(user.email))));
      }
      return { session, answers };
    };
    await h.emulator.answerEmailOtp((await fourWrong()).session, h.lastCode(user.email));
    // Counted from zero again: without the reset, the first of these would be the fifth failure.
    expect((await fourWrong()).answers).toEqual(Array(4).fill('code_mismatch'));
    h.clock.advance({ minutes: 15 });
    const session = sessionOf(await h.emulator.startEmailOtp(user.email));
    expect(await refusal(h.emulator.answerEmailOtp(session, h.wrongCode(user.email)))).toBe(
      'code_mismatch',
    );
  });

  // Value: protects=parallel guesses cannot beat the lockout, and one code signs in once; fails_when=concurrent wrong answers undercount, or two concurrent right answers both get tokens; why_new=review finding (WP0.5); seam=DynamoDB Local conditional writes; no_claim=request timing
  it('concurrent answers: every wrong guess counts and a right code signs in once', async () => {
    const guessed = await h.client();
    const sessions = await Promise.all(
      Array.from({ length: 5 }, () => h.emulator.startEmailOtp(guessed.email)),
    );
    const wrong = h.wrongCode(guessed.email);
    const answers = await Promise.all(
      sessions.map((step) => refusal(h.emulator.answerEmailOtp(sessionOf(step), wrong))),
    );
    expect(answers).toContain('too_many_attempts');

    const user = await h.client();
    const session = sessionOf(await h.emulator.startEmailOtp(user.email));
    const code = h.lastCode(user.email);
    const results = await Promise.allSettled([
      h.emulator.answerEmailOtp(session, code),
      h.emulator.answerEmailOtp(session, code),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  // Value: protects=a failed code email does not reveal that the email is a client's; fails_when=a delivery error changes the answer; why_new=review finding (WP0.5); seam=FakeChannel.failNext; no_claim=retrying the delivery (WP0.6 outbox)
  it('a code that cannot be delivered gives the same answer', async () => {
    const user = await h.client();
    h.channel.failNext(new Error('smtp down'));
    expect(await h.emulator.startEmailOtp(user.email)).toEqual({
      kind: 'challenge',
      challenge: 'EMAIL_OTP',
      session: expect.any(String),
    });
  });

  // Value: protects=the answer to a client's code request does not wait for the SMTP round trip, so its timing cannot tell clients from strangers; fails_when=startEmailOtp awaits the channel again; why_new=TODOS "Code delivery must not time the answer" (WP0.5 review), due when Mailpit replaced the console channel; seam=a channel whose send never settles; no_claim=equal database work for both (the lockout read now runs for every email, by inspection)
  it('the answer does not wait for the code email to be sent', async () => {
    const t = createTestEmulator({
      doc: testDocumentClient(),
      table: TEST_TABLE,
      clock: h.clock,
      channel: { channel: 'email', send: () => new Promise(() => {}) },
      config: { poolId: freshTenant(), tenantId: freshTenant() },
    });
    const user = await t.identity.createUser({ email: 'lenta@example.test', role: 'client' });
    await expect(t.emulator.startEmailOtp(user.email)).resolves.toMatchObject({
      challenge: 'EMAIL_OTP',
    });
  });

  // Value: protects=a code stops working after 5 minutes with its own error code; fails_when=an old code is accepted, or expiry reads as a wrong code; why_new=first emulator; seam=FixedClock; no_claim=the Italian message (WP0.7 Strings)
  it('an expired code is refused with a clear message', async () => {
    const user = await h.client();
    const session = sessionOf(await h.emulator.startEmailOtp(user.email));
    h.clock.advance({ minutes: 5 });
    expect(await refusal(h.emulator.answerEmailOtp(session, h.lastCode(user.email)))).toBe(
      'code_expired',
    );
  });

  // Value: protects=an unknown email's code step locks after five wrong answers and expires after 5 minutes exactly like a client's, so neither tells a stranger from a client; fails_when=a decoy session never counts failures or reads code_mismatch after expiry; why_new=state-machines finding (WP0.5 ship run 2); seam=none; no_claim=response timing
  it("an unknown email's code step locks and expires like a client's", async () => {
    const decoy = sessionOf(await h.emulator.startEmailOtp('nessuno-blocco@example.test'));
    const answers: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      answers.push(await refusal(h.emulator.answerEmailOtp(decoy, '12345678')));
    }
    expect(answers).toEqual([...Array(4).fill('code_mismatch'), 'too_many_attempts']);

    const late = sessionOf(await h.emulator.startEmailOtp('nessuno-scade@example.test'));
    h.clock.advance({ minutes: 5 });
    expect(await refusal(h.emulator.answerEmailOtp(late, '12345678'))).toBe('code_expired');
  });

  // Value: protects=blocking also ends the device session (§8.1); fails_when=a disabled user or a global sign-out still refreshes; why_new=first emulator; seam=none; no_claim=the API's per-request status check (WP0.4 specs)
  it('a blocked client cannot refresh, and a global sign-out ends every device session', async () => {
    const user = await h.client();
    const signIn = async () => {
      const session = sessionOf(await h.emulator.startEmailOtp(user.email));
      return h.emulator.answerEmailOtp(session, h.lastCode(user.email));
    };
    const phone = await signIn();
    const laptop = await signIn();
    await h.identity.globalSignOut(user.userId);
    expect(await refusal(h.emulator.refresh(phone.refreshToken))).toBe('not_authorized');
    expect(await refusal(h.emulator.refresh(laptop.refreshToken))).toBe('not_authorized');

    const again = await signIn();
    await h.identity.disableUser(user.userId);
    expect(await refusal(h.emulator.refresh(again.refreshToken))).toBe('not_authorized');
  });

  // Value: protects=blocking stops a sign-in already under way and a right password; fails_when=a code or TOTP step opened before the block, or a disabled therapist's password, still yields tokens; why_new=refresh-only block coverage so far; seam=none; no_claim=Cognito's pre-authentication trigger (WP0.9)
  it('a blocked account cannot finish a sign-in started before the block, nor sign in with the right password', async () => {
    const client = await h.client();
    const otp = sessionOf(await h.emulator.startEmailOtp(client.email));
    await h.identity.disableUser(client.userId);
    expect(await refusal(h.emulator.answerEmailOtp(otp, h.lastCode(client.email)))).toBe(
      'not_authorized',
    );

    const therapist = await h.therapist();
    const totp = sessionOf(
      await h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD),
    );
    await h.identity.disableUser(therapist.userId);
    expect(await refusal(h.emulator.answerTotp(totp, await h.totp(therapist.secret)))).toBe(
      'not_authorized',
    );
    expect(await refusal(h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD))).toBe(
      'not_authorized',
    );
  });

  // Value: protects=a refresh token renews once even when two tabs use it at the same moment; fails_when=takeRefresh's conditional delete is dropped and both get tokens; why_new=state-machines finding (WP0.5): only sequential reuse was specced; seam=DynamoDB Local conditional writes; no_claim=Cognito's rotation grace period (TODOS)
  it('a refresh token used twice at once renews once', async () => {
    const user = await h.client();
    const session = sessionOf(await h.emulator.startEmailOtp(user.email));
    const tokens = await h.emulator.answerEmailOtp(session, h.lastCode(user.email));
    const results = await Promise.allSettled([
      h.emulator.refresh(tokens.refreshToken),
      h.emulator.refresh(tokens.refreshToken),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    // The race at the store, independent of request timing: one take wins.
    const next = results.find((result) => result.status === 'fulfilled');
    if (next?.status !== 'fulfilled') throw new Error('Expected one renewal');
    const hash = sha256(next.value.refreshToken);
    const takes = await Promise.all([h.store.takeRefresh(hash), h.store.takeRefresh(hash)]);
    expect(takes.toSorted()).toEqual([false, true]);
  });

  // Value: protects=a count a successful sign-in just cleared is not rebuilt as a lock; fails_when=lockAttempts loses its attribute_exists condition and writes a lock without failures; why_new=state-machines finding (WP0.5); seam=the store; no_claim=none beyond protects
  it('a lock arriving after a successful sign-in cleared the count is dropped', async () => {
    const email = 'pulita@example.test';
    await h.store.recordFailure(email, h.clock.now(), 900);
    await h.store.clearAttempts(email);
    await h.store.lockAttempts(email, '2027-03-01T08:15:00.000Z');
    expect(await h.store.getAttempts(email)).toBeUndefined();
  });
});

describe('T1 Sign in with TOTP (local auth emulator)', () => {
  // Value: protects=the therapist's password + TOTP sign-in yields therapist tokens; fails_when=the TOTP step is skipped or the role claim is wrong; why_new=first emulator; seam=otplib at the fixed clock; no_claim=Cognito's challenge (cloud contract)
  it('signs in with email, password and TOTP code', async () => {
    const therapist = await h.therapist();
    const step = await h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD);
    expect(step).toEqual({
      kind: 'challenge',
      challenge: 'SOFTWARE_TOKEN_MFA',
      session: expect.any(String),
    });
    const tokens = await h.emulator.answerTotp(sessionOf(step), await h.totp(therapist.secret));
    expect(jwtPayload(tokens.accessToken)).toMatchObject({
      sub: therapist.userId,
      role: 'therapist',
    });
  });

  // Value: protects=a password alone never gives the therapist tokens; fails_when=a sign-in returns tokens without the TOTP challenge while the preference is on; why_new=first emulator; seam=none; no_claim=the cloud pool (contract spec on dev)
  it('is always challenged for TOTP and cannot sign in without the code', async () => {
    const therapist = await h.therapist();
    for (let attempt = 0; attempt < 3; attempt++) {
      const step = await h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD);
      expect(step.kind).toBe('challenge');
    }
  });

  // Value: protects=a wrong TOTP or password is refused and counts toward the lockout, and a TOTP step opened before the lock cannot be answered while it lasts; fails_when=a wrong code is accepted, failures are not counted, or answerTotp skips the lock check; why_new=first emulator; seam=none; no_claim=replay protection within one 30-second step
  it('wrong TOTP code is refused; wrong passwords lock the account for a while', async () => {
    const therapist = await h.therapist();
    const session = sessionOf(
      await h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD),
    );
    const right = await h.totp(therapist.secret);
    const wrong = `${(Number(right[0]) + 1) % 10}${right.slice(1)}`;
    expect(await refusal(h.emulator.answerTotp(session, wrong))).toBe('code_mismatch');

    const answers: string[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      answers.push(
        await refusal(h.emulator.signInWithPassword(therapist.email, 'sbagliata-sbagliata')),
      );
    }
    expect(answers).toEqual([
      'not_authorized',
      'not_authorized',
      'not_authorized',
      'too_many_attempts',
    ]);
    expect(await refusal(h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD))).toBe(
      'too_many_attempts',
    );
    // The step opened before the lock is locked too, even with the right code.
    expect(await refusal(h.emulator.answerTotp(session, right))).toBe('too_many_attempts');
  });

  // Value: protects=a TOTP code is good once, as on Cognito; fails_when=the same code signs in twice within its 90-second window; why_new=review finding (WP0.5); seam=FixedClock; no_claim=clock drift beyond one step
  it('a TOTP code already used is refused', async () => {
    const therapist = await h.therapist();
    const code = await h.totp(therapist.secret);
    const signIn = async () =>
      sessionOf(await h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD));
    await expect(h.emulator.answerTotp(await signIn(), code)).resolves.toHaveProperty(
      'accessToken',
    );
    expect(await refusal(h.emulator.answerTotp(await signIn(), code))).toBe('code_mismatch');
    h.clock.advance({ seconds: 30 });
    await expect(
      h.emulator.answerTotp(await signIn(), await h.totp(therapist.secret)),
    ).resolves.toHaveProperty('accessToken');
  });

  // Value: protects=a setup link cannot be finished twice or after it was replaced; fails_when=a second session on a spent code, or a session on a replaced code, overwrites the password and secret; why_new=review finding (WP0.5); seam=none; no_claim=the Cognito temporary password (WP0.10)
  it('a setup code is spent by the first enrolment, and a replaced code cannot finish', async () => {
    const user = await h.identity.createUser({ email: 'twice@example.test', role: 'therapist' });
    const code = await h.identity.startPasswordSetup(user.userId);
    const a = await h.emulator.startSetup(code, THERAPIST_PASSWORD);
    const b = await h.emulator.startSetup(code, 'altra-password-lunga');
    await h.emulator.verifyTotpSetup(a.session, await h.totp(a.secret));
    expect(await refusal(h.emulator.verifyTotpSetup(b.session, await h.totp(b.secret)))).toBe(
      'not_authorized',
    );

    const other = await h.identity.createUser({
      email: 'replaced@example.test',
      role: 'therapist',
    });
    const old = await h.emulator.startSetup(
      await h.identity.startPasswordSetup(other.userId),
      THERAPIST_PASSWORD,
    );
    await h.identity.startPasswordSetup(other.userId);
    expect(await refusal(h.emulator.verifyTotpSetup(old.session, await h.totp(old.secret)))).toBe(
      'not_authorized',
    );
  });

  // Value: protects=the bootstrap setup link works once and enforces the password policy; fails_when=a short password is accepted, a used or replaced code works again; why_new=first setup flow; seam=none; no_claim=the SPA setup page (WP0.7)
  it('the one-time setup code sets the password and enrols TOTP, once', async () => {
    const user = await h.identity.createUser({ email: 'setup@example.test', role: 'therapist' });
    const replaced = await h.identity.startPasswordSetup(user.userId);
    const code = await h.identity.startPasswordSetup(user.userId);
    expect(await refusal(h.emulator.startSetup(replaced, THERAPIST_PASSWORD))).toBe(
      'not_authorized',
    );
    expect(await refusal(h.emulator.startSetup(code, 'corta'))).toBe('invalid_password');

    const enrolment = await h.emulator.startSetup(code, THERAPIST_PASSWORD);
    expect(enrolment.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(await refusal(h.emulator.verifyTotpSetup(enrolment.session, '000000'))).toBe(
      'code_mismatch',
    );
    await h.emulator.verifyTotpSetup(enrolment.session, await h.totp(enrolment.secret));
    expect(await h.identity.findUserByEmail(user.email)).toMatchObject({ passwordSet: true });
    expect(await refusal(h.emulator.startSetup(code, THERAPIST_PASSWORD))).toBe('not_authorized');
  });

  // Value: protects=the therapist's device session is 7 days (§8.1), not the clients' 30; fails_when=the therapist's refresh token gets the client lifetime or the role lookup is dropped; why_new=only the 30-day client lifetime is specced; seam=FixedClock; no_claim=the Cognito app client's own setting (infra, WP0.9)
  it('the therapist stays signed in for 7 days', async () => {
    const therapist = await h.therapist();
    const step = await h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD);
    const first = await h.emulator.answerTotp(sessionOf(step), await h.totp(therapist.secret));

    h.clock.advance({ days: 6 });
    const second = await h.emulator.refresh(first.refreshToken);
    h.clock.advance({ days: 1 });
    expect(await refusal(h.emulator.refresh(second.refreshToken))).toBe('not_authorized');
  });

  // Value: protects=a printed setup link stops working after 7 days and for a disabled account; fails_when=the setup record's expiry or the enabled check is dropped from startSetup; why_new=only replaced and spent codes are specced; seam=FixedClock; no_claim=Cognito's temporary-password expiry (WP0.10)
  it('a setup link expires after 7 days and is refused once the account is disabled', async () => {
    const late = await h.identity.createUser({ email: 'scaduto@example.test', role: 'therapist' });
    const code = await h.identity.startPasswordSetup(late.userId);
    h.clock.advance({ days: 6, hours: 23, minutes: 59 });
    await expect(h.emulator.startSetup(code, THERAPIST_PASSWORD)).resolves.toHaveProperty('secret');
    h.clock.advance({ minutes: 1 });
    expect(await refusal(h.emulator.startSetup(code, THERAPIST_PASSWORD))).toBe('not_authorized');

    const blocked = await h.identity.createUser({
      email: 'bloccato@example.test',
      role: 'therapist',
    });
    const blockedCode = await h.identity.startPasswordSetup(blocked.userId);
    await h.identity.disableUser(blocked.userId);
    expect(await refusal(h.emulator.startSetup(blockedCode, THERAPIST_PASSWORD))).toBe(
      'not_authorized',
    );
  });

  // Value: protects=the TOTP challenge follows the user's MFA preference; fails_when=the preference check is inverted, or the challenge is skipped or forced wrongly; why_new=only preference-on is specced; seam=none; no_claim=Cognito's MFA-optional behaviour (WP0.10)
  it('without the TOTP preference the password signs in without a challenge', async () => {
    const therapist = await h.therapist();
    await h.identity.setTotpPreference(therapist.userId, { enabled: false, preferred: false });
    expect(await h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD)).toMatchObject({
      kind: 'signedIn',
      tokens: { accessToken: expect.any(String) },
    });

    await h.identity.setTotpPreference(therapist.userId, { enabled: true, preferred: true });
    expect(await h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD)).toMatchObject({
      kind: 'challenge',
      challenge: 'SOFTWARE_TOKEN_MFA',
    });
  });

  // Value: protects=a password-proven step and an enrolment step last 5 minutes, and an expired enrolment stores nothing while the link stays usable; fails_when=the expiry check is dropped from answerTotp or verifyTotpSetup (the TTL deletes lazily); why_new=state-machines and testing findings (WP0.5): only the email code's expiry was specced; seam=FixedClock; no_claim=Cognito's AuthSessionValidity (WP0.9)
  it('a TOTP step or an enrolment left open for 5 minutes is refused', async () => {
    const therapist = await h.therapist();
    const step = sessionOf(
      await h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD),
    );
    h.clock.advance({ minutes: 5 });
    expect(await refusal(h.emulator.answerTotp(step, await h.totp(therapist.secret)))).toBe(
      'invalid_session',
    );

    const user = await h.identity.createUser({ email: 'lenta@example.test', role: 'therapist' });
    const code = await h.identity.startPasswordSetup(user.userId);
    const enrolment = await h.emulator.startSetup(code, THERAPIST_PASSWORD);
    h.clock.advance({ minutes: 5 });
    expect(
      await refusal(h.emulator.verifyTotpSetup(enrolment.session, await h.totp(enrolment.secret))),
    ).toBe('invalid_session');
    expect(await storedSecrets(user.userId)).toEqual([undefined, undefined]);
    await expect(h.emulator.startSetup(code, THERAPIST_PASSWORD)).resolves.toHaveProperty('secret');
  });

  // Value: protects=wrong TOTP codes count toward the lockout at sign-in and at enrolment, the fifth ends the step, and a failed enrolment stores nothing; fails_when=TOTP or enrolment failures are not counted, the step survives the lockout, or a malformed code is not refused like a wrong one; why_new=state-machines finding (WP0.5): the lockout was reached only with wrong passwords; seam=none; no_claim=Cognito's own lockout counts
  it('five wrong TOTP codes lock the email and end the step, at sign-in and at enrolment', async () => {
    const therapist = await h.therapist();
    const step = sessionOf(
      await h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD),
    );
    const right = await h.totp(therapist.secret);
    const wrong = `${(Number(right[0]) + 1) % 10}${right.slice(1)}`;
    const answers: string[] = [];
    for (const code of [wrong, wrong, 'abcdef', wrong, wrong]) {
      answers.push(await refusal(h.emulator.answerTotp(step, code)));
    }
    expect(answers).toEqual([
      'code_mismatch',
      'code_mismatch',
      'code_mismatch',
      'code_mismatch',
      'too_many_attempts',
    ]);
    expect(await h.store.getSession(step)).toBeUndefined();

    const user = await h.identity.createUser({ email: 'sbaglia@example.test', role: 'therapist' });
    const enrolment = await h.emulator.startSetup(
      await h.identity.startPasswordSetup(user.userId),
      THERAPIST_PASSWORD,
    );
    const first = await h.totp(enrolment.secret);
    const bad = `${(Number(first[0]) + 1) % 10}${first.slice(1)}`;
    const setupAnswers: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      setupAnswers.push(await refusal(h.emulator.verifyTotpSetup(enrolment.session, bad)));
    }
    expect(setupAnswers.at(-1)).toBe('too_many_attempts');
    expect(await h.store.getSession(enrolment.session)).toBeUndefined();
    expect(await storedSecrets(user.userId)).toEqual([undefined, undefined]);
  });

  // Value: protects=a block during enrolment stores neither the password nor the secret; fails_when=verifyTotpSetup skips the enabled check; why_new=state-machines finding (WP0.5); seam=none; no_claim=none beyond protects
  it('a block during enrolment stores nothing', async () => {
    const user = await h.identity.createUser({ email: 'fermata@example.test', role: 'therapist' });
    const enrolment = await h.emulator.startSetup(
      await h.identity.startPasswordSetup(user.userId),
      THERAPIST_PASSWORD,
    );
    await h.identity.disableUser(user.userId);
    expect(
      await refusal(h.emulator.verifyTotpSetup(enrolment.session, await h.totp(enrolment.secret))),
    ).toBe('not_authorized');
    expect(await storedSecrets(user.userId)).toEqual([undefined, undefined]);
  });

  // Value: protects=an enrolment opened just before the setup link expired can finish within its 5 minutes; fails_when=verifyTotpSetup starts refusing on the link's expiry, stranding a therapist mid-enrolment; why_new=state-machines finding (WP0.5): the boundary was undocumented; seam=FixedClock; no_claim=Cognito's temporary-password expiry
  it('an enrolment started before the setup link expired can finish', async () => {
    const user = await h.identity.createUser({ email: 'limite@example.test', role: 'therapist' });
    const code = await h.identity.startPasswordSetup(user.userId);
    h.clock.advance({ days: 6, hours: 23, minutes: 59 });
    const enrolment = await h.emulator.startSetup(code, THERAPIST_PASSWORD);
    h.clock.advance({ minutes: 2 });
    await expect(
      h.emulator.verifyTotpSetup(enrolment.session, await h.totp(enrolment.secret)),
    ).resolves.toHaveProperty('accessToken');
  });

  // Value: protects=a locked email cannot finish an enrolment, even with the right code, and nothing is stored; fails_when=verifyTotpSetup skips the lock check; why_new=state-machines finding (WP0.5); seam=none; no_claim=none beyond protects
  it('an enrolment is refused while its email is locked, and stores nothing', async () => {
    const user = await h.identity.createUser({ email: 'chiusa@example.test', role: 'therapist' });
    const enrolment = await h.emulator.startSetup(
      await h.identity.startPasswordSetup(user.userId),
      THERAPIST_PASSWORD,
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      await refusal(h.emulator.signInWithPassword(user.email, 'sbagliata-sbagliata'));
    }
    expect(
      await refusal(h.emulator.verifyTotpSetup(enrolment.session, await h.totp(enrolment.secret))),
    ).toBe('too_many_attempts');
    expect(await h.identity.findUserByEmail(user.email)).toMatchObject({ passwordSet: false });
  });

  // Value: protects=a double submit of the right TOTP code, at sign-in or at enrolment, succeeds once; fails_when=neither the code's single use nor the session's conditional delete stops the second answer, or takeSession lets two takes win (the store-level race); why_new=state-machines and testing findings (WP0.5); seam=DynamoDB Local conditional writes; no_claim=request timing
  it('two answers with the right TOTP code at once succeed once, at sign-in and at enrolment', async () => {
    const therapist = await h.therapist();
    const step = sessionOf(
      await h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD),
    );
    const code = await h.totp(therapist.secret);
    const signIns = await Promise.allSettled([
      h.emulator.answerTotp(step, code),
      h.emulator.answerTotp(step, code),
    ]);
    expect(signIns.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    const user = await h.identity.createUser({ email: 'doppia@example.test', role: 'therapist' });
    const enrolment = await h.emulator.startSetup(
      await h.identity.startPasswordSetup(user.userId),
      THERAPIST_PASSWORD,
    );
    const first = await h.totp(enrolment.secret);
    const setups = await Promise.allSettled([
      h.emulator.verifyTotpSetup(enrolment.session, first),
      h.emulator.verifyTotpSetup(enrolment.session, first),
    ]);
    expect(setups.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    // The race at the store, independent of the code's single use: one take wins.
    const open = await h.emulator.startSetup(
      await h.identity.startPasswordSetup(user.userId),
      THERAPIST_PASSWORD,
    );
    const takes = await Promise.all([
      h.store.takeSession(open.session),
      h.store.takeSession(open.session),
    ]);
    expect(takes.toSorted()).toEqual([false, true]);
  });

  // Value: protects=a session answers only the step it was opened for; fails_when=#openSession stops checking the kind, so an email-code session skips TOTP or an enrolment session signs in; why_new=state-machines finding (WP0.5 ship cycle 3); seam=none; no_claim=Cognito's session strings (opaque there)
  it('a session answers only its own step', async () => {
    const client = await h.client();
    const emailStep = sessionOf(await h.emulator.startEmailOtp(client.email));
    const therapist = await h.therapist();
    const totpStep = sessionOf(
      await h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD),
    );
    const user = await h.identity.createUser({
      email: 'altro-passo@example.test',
      role: 'therapist',
    });
    const enrolment = await h.emulator.startSetup(
      await h.identity.startPasswordSetup(user.userId),
      THERAPIST_PASSWORD,
    );
    const totp = await h.totp(therapist.secret);
    expect([
      await refusal(h.emulator.answerTotp(emailStep, totp)),
      await refusal(h.emulator.answerEmailOtp(totpStep, h.lastCode(client.email))),
      await refusal(h.emulator.answerTotp(enrolment.session, await h.totp(enrolment.secret))),
      await refusal(h.emulator.verifyTotpSetup(totpStep, totp)),
    ]).toEqual(['invalid_session', 'invalid_session', 'invalid_session', 'invalid_session']);
  });

  // Value: protects=a right password does not reset the wrong-TOTP count, so the second factor cannot be guessed four codes per password; fails_when=signInWithPassword clears the failures before the TOTP step is answered; why_new=state-machines finding (WP0.5 ship cycle 3); seam=none; no_claim=Cognito's own counting
  it('a right password keeps the count of wrong TOTP codes', async () => {
    const therapist = await h.therapist();
    const signIn = async () =>
      sessionOf(await h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD));
    const right = await h.totp(therapist.secret);
    const wrong = `${(Number(right[0]) + 1) % 10}${right.slice(1)}`;
    const first = await signIn();
    for (let attempt = 0; attempt < 4; attempt++) {
      await refusal(h.emulator.answerTotp(first, wrong));
    }
    expect(await refusal(h.emulator.answerTotp(await signIn(), wrong))).toBe('too_many_attempts');
  });

  // Value: protects=the therapist's email is read as typed on a phone (any case, stray spaces), at sign-in and by the lockout; fails_when=signInWithPassword stops normalising the email, or counts and checks the lock under the raw spelling so case variants dodge it; why_new=only the code flow is specced with a mixed-case email; seam=none; no_claim=Cognito's case-insensitive username (pool setting, WP0.9)
  it('the password step accepts the email in any letter case, and its lockout counts every spelling', async () => {
    const therapist = await h.therapist();
    const spellings = [
      therapist.email.toUpperCase(),
      ` ${therapist.email} `,
      `${therapist.email[0]?.toUpperCase()}${therapist.email.slice(1)}`,
    ];
    expect(
      await h.emulator.signInWithPassword(spellings[0] ?? '', THERAPIST_PASSWORD),
    ).toMatchObject({ kind: 'challenge', challenge: 'SOFTWARE_TOKEN_MFA' });

    const answers: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const email = spellings[attempt % spellings.length] ?? '';
      answers.push(await refusal(h.emulator.signInWithPassword(email, 'sbagliata-sbagliata')));
    }
    expect(answers).toEqual([...Array(4).fill('not_authorized'), 'too_many_attempts']);
    expect(await refusal(h.emulator.signInWithPassword(therapist.email, THERAPIST_PASSWORD))).toBe(
      'too_many_attempts',
    );
  });

  // Value: protects=the password step does not tell a wrong password from an unknown email, a client's email or an unfinished setup; fails_when=a passwordless or unknown account gets another code or an internal error instead of not_authorized; why_new=enumeration is specced on the code flow only; seam=none; no_claim=response timing (scrypt runs only for a stored password)
  it('a wrong password, an unknown email, a client and an unfinished setup get the same refusal', async () => {
    const therapist = await h.therapist();
    const client = await h.client();
    const pending = await h.identity.createUser({
      email: 'senza-password@example.test',
      role: 'therapist',
    });
    await h.identity.startPasswordSetup(pending.userId);
    expect([
      await refusal(h.emulator.signInWithPassword(therapist.email, 'sbagliata-sbagliata')),
      await refusal(h.emulator.signInWithPassword('nessuno-pw@example.test', THERAPIST_PASSWORD)),
      await refusal(h.emulator.signInWithPassword(client.email, THERAPIST_PASSWORD)),
      await refusal(h.emulator.signInWithPassword(pending.email, THERAPIST_PASSWORD)),
    ]).toEqual(['not_authorized', 'not_authorized', 'not_authorized', 'not_authorized']);
  });

  // Value: protects=both adapters read an enrolled authenticator as `totpEnrolled` only while the TOTP preference is on, as Cognito lists it (§15), so bootstrap decides the same on each; fails_when=the emulator reports the stored secret alone; why_new=api-contract finding (WP0.5 ship cycle 3); seam=none; no_claim=Cognito's UserMFASettingList (WP0.10 spike)
  it('an enrolled authenticator shows only while the TOTP preference is on', async () => {
    const therapist = await h.therapist();
    expect(await h.identity.findUserByEmail(therapist.email)).toMatchObject({ totpEnrolled: true });
    await h.identity.setTotpPreference(therapist.userId, { enabled: false, preferred: false });
    expect(await h.identity.findUserByEmail(therapist.email)).toMatchObject({
      totpEnrolled: false,
    });
    await h.identity.setTotpPreference(therapist.userId, { enabled: true, preferred: true });
    expect(await h.identity.findUserByEmail(therapist.email)).toMatchObject({ totpEnrolled: true });
  });
});
