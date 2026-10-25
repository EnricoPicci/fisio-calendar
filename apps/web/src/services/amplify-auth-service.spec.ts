import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeJwt } from '../../test/support/jwt';

const amplify = vi.hoisted(() => ({
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
  setUpTOTP: vi.fn(),
  verifyTOTPSetup: vi.fn(),
  updateMFAPreference: vi.fn(),
  fetchAuthSession: vi.fn(),
  fetchMFAPreference: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('aws-amplify/auth', () => amplify);
vi.mock('aws-amplify', () => ({ Amplify: { configure: vi.fn() } }));

import { AmplifyAuthService } from './amplify-auth-service';
import { AuthError } from './auth-service';
import { NetworkError } from './network-error';

/**
 * The Amplify service against a mocked SDK: the invariants the cloud build must keep whatever
 * Cognito answers. The flow names themselves are verified on `dev` (WP0.10 spike).
 */
const session = (role: 'client' | 'therapist') => ({
  tokens: {
    accessToken: { toString: () => fakeJwt({ role, exp: 9_999_999_999 }) },
    idToken: { toString: () => fakeJwt({ role, exp: 9_999_999_999 }) },
  },
});
const exception = (name: string) => Object.assign(new Error(name), { name });
const refused = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof AuthError ? error.code : error),
  );
const PASSWORD = 'password-of-twelve';
const noTotp = { enabled: undefined, preferred: undefined };
const totp = { enabled: ['TOTP'], preferred: 'TOTP' };

describe('AmplifyAuthService invariants (architecture §8.1, §15)', () => {
  let service: AmplifyAuthService;

  beforeEach(() => {
    for (const mock of Object.values(amplify)) mock.mockReset();
    amplify.signOut.mockResolvedValue(undefined);
    service = new AmplifyAuthService();
  });

  it('requestCode(): an unknown or refused address answers like a client (no enumeration)', async () => {
    amplify.signIn.mockRejectedValueOnce(exception('UserNotFoundException'));
    await expect(firstValueFrom(service.requestCode('nobody@example.it'))).resolves.toBeUndefined();
    amplify.signIn.mockRejectedValueOnce(exception('NotAuthorizedException'));
    await expect(
      firstValueFrom(service.requestCode('blocked@example.it')),
    ).resolves.toBeUndefined();
  });

  it('confirmCode() after a refused address fails as a wrong code, without a call that would differ', async () => {
    amplify.signIn.mockRejectedValueOnce(exception('UserNotFoundException'));
    await firstValueFrom(service.requestCode('nobody@example.it'));

    await expect(refused(firstValueFrom(service.confirmCode('12345678')))).resolves.toBe(
      'code_mismatch',
    );
    expect(amplify.confirmSignIn).not.toHaveBeenCalled();

    // A later, accepted request clears it.
    amplify.signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE' },
    });
    await firstValueFrom(service.requestCode('anna@example.it'));
    amplify.confirmSignIn.mockResolvedValueOnce({
      isSignedIn: true,
      nextStep: { signInStep: 'DONE' },
    });
    amplify.fetchAuthSession.mockResolvedValueOnce(session('client'));
    await expect(firstValueFrom(service.confirmCode('12345678'))).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
    expect(amplify.confirmSignIn).toHaveBeenCalledTimes(1);
  });

  it('requestCode(): a failure that is not a refusal still surfaces', async () => {
    amplify.signIn.mockRejectedValueOnce(exception('NetworkError'));
    await expect(
      refused(firstValueFrom(service.requestCode('x@example.it'))),
    ).resolves.toMatchObject({
      name: 'NetworkError',
    });
  });

  it('confirmCode(): a wrong code is code_mismatch; the right one yields both tokens', async () => {
    amplify.confirmSignIn.mockRejectedValueOnce(exception('CodeMismatchException'));
    await expect(refused(firstValueFrom(service.confirmCode('0')))).resolves.toBe('code_mismatch');
    amplify.confirmSignIn.mockResolvedValueOnce({
      isSignedIn: true,
      nextStep: { signInStep: 'DONE' },
    });
    amplify.fetchAuthSession.mockResolvedValueOnce(session('client'));
    await expect(firstValueFrom(service.confirmCode('12345678'))).resolves.toMatchObject({
      accessToken: expect.any(String),
      idToken: expect.any(String),
    });
  });

  it('a therapist signed in by password alone (TOTP not enabled) is refused and signed out', async () => {
    amplify.signIn.mockResolvedValueOnce({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });
    amplify.fetchAuthSession.mockResolvedValueOnce(session('therapist'));
    amplify.fetchMFAPreference.mockResolvedValueOnce(noTotp);

    await expect(
      refused(firstValueFrom(service.signInWithPassword('t@example.it', 'password-of-twelve'))),
    ).resolves.toBe('not_authorized');
    expect(amplify.signOut).toHaveBeenCalledTimes(1);
  });

  it('a therapist code sign-in that Cognito completed without TOTP is refused the same way', async () => {
    amplify.confirmSignIn.mockResolvedValueOnce({
      isSignedIn: true,
      nextStep: { signInStep: 'DONE' },
    });
    amplify.fetchAuthSession.mockResolvedValueOnce(session('therapist'));
    amplify.fetchMFAPreference.mockResolvedValueOnce(noTotp);
    await expect(refused(firstValueFrom(service.confirmCode('12345678')))).resolves.toBe(
      'not_authorized',
    );
    expect(amplify.signOut).toHaveBeenCalledTimes(1);
  });

  it('startSetup(): a failure after the password step signs out, never leaving a single-factor session', async () => {
    amplify.signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
    });
    amplify.confirmSignIn.mockResolvedValueOnce({
      isSignedIn: true,
      nextStep: { signInStep: 'DONE' },
    });
    amplify.setUpTOTP.mockRejectedValueOnce(exception('NetworkError'));

    await expect(
      refused(
        firstValueFrom(
          service.startSetup({
            email: 't@example.it',
            code: 'tmp',
            password: PASSWORD,
          }),
        ),
      ),
    ).resolves.toMatchObject({ name: 'NetworkError' });

    expect(amplify.signOut).toHaveBeenCalledTimes(1);
  });

  it('startSetup(): a sign-in Cognito completes without the new-password step is refused and signed out', async () => {
    amplify.signIn.mockResolvedValueOnce({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });
    await expect(
      refused(
        firstValueFrom(
          service.startSetup({
            email: 't@example.it',
            code: 'tmp',
            password: PASSWORD,
          }),
        ),
      ),
    ).resolves.toBe('not_authorized');
    expect(amplify.signOut).toHaveBeenCalledTimes(1);
  });

  it('verifyTotpSetup(): makes TOTP preferred and hands out the tokens once it is enabled', async () => {
    amplify.verifyTOTPSetup.mockResolvedValueOnce(undefined);
    amplify.updateMFAPreference.mockResolvedValueOnce(undefined);
    amplify.fetchAuthSession.mockResolvedValueOnce(session('therapist'));
    amplify.fetchMFAPreference.mockResolvedValueOnce(totp);
    await expect(firstValueFrom(service.verifyTotpSetup('123456'))).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
    expect(amplify.updateMFAPreference).toHaveBeenCalledWith({ totp: 'PREFERRED' });
  });

  it('restore(): a therapist session without TOTP enabled is signed out and not restored', async () => {
    amplify.fetchAuthSession.mockResolvedValueOnce(session('therapist'));
    amplify.fetchMFAPreference.mockResolvedValueOnce(noTotp);
    await expect(firstValueFrom(service.restore())).resolves.toBeNull();
    expect(amplify.signOut).toHaveBeenCalledTimes(1);
  });

  it('restore(): a therapist with TOTP enabled, and any client, is restored', async () => {
    amplify.fetchAuthSession.mockResolvedValueOnce(session('therapist'));
    amplify.fetchMFAPreference.mockResolvedValueOnce(totp);
    await expect(firstValueFrom(service.restore())).resolves.not.toBeNull();
    amplify.fetchAuthSession.mockResolvedValueOnce(session('client'));
    await expect(firstValueFrom(service.restore())).resolves.not.toBeNull();
    expect(amplify.fetchMFAPreference).toHaveBeenCalledTimes(1);
    expect(amplify.signOut).not.toHaveBeenCalled();
  });

  // Added by the ship-workflow coverage audit (Claude Fable 5.1).
  // Value: protects=the therapist's two-step sign-in over Amplify: SOFTWARE_TOKEN_MFA step → totp_required, then confirmTotp;
  // fails_when=the TOTP step name or the PASSWORD_SRP flow drifts, or another step passes as signed in;
  // why_new=the existing cases cover only refusals and the no-TOTP guard; seam=none;
  // no_claim=what Cognito really answers (dev spike, WP0.10).
  it('signInWithPassword(): the TOTP challenge is totp_required and confirmTotp() then yields the tokens; any other step is refused', async () => {
    amplify.signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' },
    });
    await expect(
      firstValueFrom(service.signInWithPassword('t@example.it', PASSWORD)),
    ).resolves.toEqual({ kind: 'totp_required' });
    expect(amplify.signIn).toHaveBeenCalledWith({
      username: 't@example.it',
      password: PASSWORD,
      options: { authFlowType: 'USER_AUTH', preferredChallenge: 'PASSWORD_SRP' },
    });

    amplify.confirmSignIn.mockResolvedValueOnce({
      isSignedIn: true,
      nextStep: { signInStep: 'DONE' },
    });
    amplify.fetchAuthSession.mockResolvedValueOnce(session('therapist'));
    amplify.fetchMFAPreference.mockResolvedValueOnce(totp);
    await expect(firstValueFrom(service.confirmTotp('123456'))).resolves.toMatchObject({
      accessToken: expect.any(String),
      idToken: expect.any(String),
    });
    expect(amplify.confirmSignIn).toHaveBeenCalledWith({ challengeResponse: '123456' });
    expect(amplify.signOut).not.toHaveBeenCalled();

    amplify.signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_SMS_CODE' },
    });
    await expect(
      refused(firstValueFrom(service.signInWithPassword('t@example.it', PASSWORD))),
    ).resolves.toBe('not_authorized');
  });

  // Added by the ship-workflow coverage audit (Claude Fable 5.1).
  // Value: protects=startSetup() success: temporary password, new password, TOTP enrolment named for the app and the email;
  // fails_when=the new-password answer or the setup URI's issuer/account drift, or a success signs out;
  // why_new=the existing startSetup cases are the two failure paths; seam=none;
  // no_claim=verifyTotpSetup (covered), the emulator's setup (local-auth-service.spec).
  it('startSetup(): answers the new-password step and returns the secret with an otpauth URI for the app and the email', async () => {
    amplify.signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
    });
    amplify.confirmSignIn.mockResolvedValueOnce({
      isSignedIn: true,
      nextStep: { signInStep: 'DONE' },
    });
    const getSetupUri = vi.fn(
      (issuer: string, account: string) =>
        new URL(
          `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=AAAABBBBCCCCDDDD`,
        ),
    );
    amplify.setUpTOTP.mockResolvedValueOnce({ sharedSecret: 'AAAABBBBCCCCDDDD', getSetupUri });

    const enrolment = await firstValueFrom(
      service.startSetup({ email: 't@example.it', code: 'tmp', password: PASSWORD }),
    );

    expect(amplify.signIn).toHaveBeenCalledWith({
      username: 't@example.it',
      password: 'tmp',
      options: { authFlowType: 'USER_AUTH', preferredChallenge: 'PASSWORD' },
    });
    expect(amplify.confirmSignIn).toHaveBeenCalledWith({ challengeResponse: PASSWORD });
    expect(getSetupUri).toHaveBeenCalledWith('Fisio Calendar', 't@example.it');
    expect(enrolment).toEqual({
      secret: 'AAAABBBBCCCCDDDD',
      otpauthUri: getSetupUri.mock.results[0]?.value.toString(),
    });
    expect(enrolment.otpauthUri).toMatch(/^otpauth:/);
    expect(amplify.signOut).not.toHaveBeenCalled();
  });

  it('refresh(): forces a refresh; nothing to refresh is not_authorized', async () => {
    amplify.fetchAuthSession.mockResolvedValueOnce(session('client'));
    await expect(firstValueFrom(service.refresh())).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
    expect(amplify.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
    amplify.fetchAuthSession.mockResolvedValueOnce({ tokens: undefined });
    await expect(refused(firstValueFrom(service.refresh()))).resolves.toBe('not_authorized');
  });

  it('refresh(): a therapist without TOTP enabled is signed out and refused; with it, refreshed', async () => {
    amplify.fetchAuthSession.mockResolvedValueOnce(session('therapist'));
    amplify.fetchMFAPreference.mockResolvedValueOnce(noTotp);
    await expect(refused(firstValueFrom(service.refresh()))).resolves.toBe('not_authorized');
    expect(amplify.signOut).toHaveBeenCalledTimes(1);

    amplify.fetchAuthSession.mockResolvedValueOnce(session('therapist'));
    amplify.fetchMFAPreference.mockResolvedValueOnce(totp);
    await expect(firstValueFrom(service.refresh())).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
    expect(amplify.signOut).toHaveBeenCalledTimes(1);
  });

  it('the TOTP check runs once per token pair: a second restore() of the same tokens asks Cognito nothing', async () => {
    amplify.fetchAuthSession.mockResolvedValue(session('therapist'));
    amplify.fetchMFAPreference.mockResolvedValueOnce(totp);
    await firstValueFrom(service.restore());
    await firstValueFrom(service.restore());
    await firstValueFrom(service.refresh());
    expect(amplify.fetchMFAPreference).toHaveBeenCalledTimes(1);
  });

  it('requestCode(): a sign-in Cognito answers with another challenge reads as refused; the code step then fails as a wrong code without a round trip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    amplify.signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_PASSWORD' },
    });
    await expect(firstValueFrom(service.requestCode('t@example.it'))).resolves.toBeUndefined();
    await expect(refused(firstValueFrom(service.confirmCode('12345678')))).resolves.toBe(
      'code_mismatch',
    );
    expect(amplify.confirmSignIn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('requestCode(): a lockout is told, not hidden behind the no-enumeration answer', async () => {
    amplify.signIn.mockRejectedValueOnce(exception('TooManyRequestsException'));
    await expect(refused(firstValueFrom(service.requestCode('anna@example.it')))).resolves.toBe(
      'too_many_attempts',
    );
  });

  it('a sign-in refused because Amplify still holds a user signs that user out and retries once', async () => {
    amplify.signIn
      .mockRejectedValueOnce(exception('UserAlreadyAuthenticatedException'))
      .mockResolvedValueOnce({
        isSignedIn: false,
        nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE' },
      });
    await expect(firstValueFrom(service.requestCode('anna@example.it'))).resolves.toBeUndefined();
    expect(amplify.signOut).toHaveBeenCalledTimes(1);
    expect(amplify.signIn).toHaveBeenCalledTimes(2);

    amplify.signIn
      .mockRejectedValueOnce(exception('UserAlreadyAuthenticatedException'))
      .mockRejectedValueOnce(exception('UserAlreadyAuthenticatedException'));
    const failure = await refused(
      firstValueFrom(service.signInWithPassword('t@example.it', PASSWORD)),
    );
    expect(failure).toMatchObject({ name: 'UserAlreadyAuthenticatedException' });
    expect(amplify.signOut).toHaveBeenCalledTimes(2);
  });

  it("Amplify's own network failure reads as offline, not as unexpected", async () => {
    amplify.confirmSignIn.mockRejectedValueOnce(exception('NetworkError'));
    const failure = await refused(firstValueFrom(service.confirmCode('12345678')));
    expect(failure).toBeInstanceOf(NetworkError);
  });
});
