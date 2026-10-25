import { closeTestDocumentClient } from '@fisio/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { AuthError, type SignInStep } from '../src/emulator';
import { jwtPayload } from '../src/testing';
import { emulatorHarness, THERAPIST_PASSWORD } from './harness';

const h = emulatorHarness();
afterAll(closeTestDocumentClient);

/** The auth error code a sign-in step was refused with. */
async function refusal(step: Promise<unknown>): Promise<string> {
  const error = await step.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof AuthError)) throw new Error(`Expected an AuthError, got ${String(error)}`);
  return error.code;
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
    h.clock.advance({ days: -30 });
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
    const after = sessionOf(await h.emulator.startEmailOtp(user.email));
    await expect(h.emulator.answerEmailOtp(after, h.lastCode(user.email))).resolves.toHaveProperty(
      'accessToken',
    );
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

  // Value: protects=a wrong TOTP or password is refused and counts toward the lockout; fails_when=a wrong code is accepted or failures are not counted; why_new=first emulator; seam=none; no_claim=replay protection within one 30-second step
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
    h.clock.advance({ minutes: 15 });
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
});
