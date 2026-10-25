import { Amplify } from 'aws-amplify';
import {
  confirmSignIn,
  fetchAuthSession,
  setUpTOTP,
  signIn,
  signOut,
  updateMFAPreference,
  verifyTOTPSetup,
} from 'aws-amplify/auth';
import { defer, from, type Observable } from 'rxjs';
import {
  AuthError,
  type AuthService,
  type AuthTokens,
  type PasswordSignInStep,
  type SetupInput,
  type TotpEnrolment,
} from './auth-service';

/**
 * The `AuthService` of the cloud build (docs/architecture.md §8.1): Amplify Auth against the
 * Cognito pool. Clients: `USER_AUTH` with `EMAIL_OTP` as the preferred challenge. Therapist:
 * password (SRP) followed by the `SOFTWARE_TOKEN_MFA` challenge Cognito issues while TOTP is her
 * preferred MFA. The setup link signs in with the temporary password, answers
 * `NEW_PASSWORD_REQUIRED`, then enrols TOTP and makes it preferred (§15: a password alone never
 * counts as a finished setup). Amplify keeps and refreshes the tokens itself; `refresh()` forces
 * one. Cognito's exceptions are mapped onto `AuthErrorCode` (D28).
 *
 * Verified against the real pool only on `dev` (WP0.10 spike, implementation plan §9): until
 * then the flow names and the exception names below are the documented ones.
 */
export interface AmplifyAuthConfig {
  readonly userPoolId: string;
  readonly userPoolClientId: string;
}

const TOTP_ISSUER = 'Fisio Calendar';

export function configureAmplify(config: AmplifyAuthConfig): void {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
        loginWith: { email: true },
      },
    },
  });
}

export class AmplifyAuthService implements AuthService {
  requestCode(email: string): Observable<void> {
    return effect(async () => {
      const step = await signIn({
        username: email,
        options: { authFlowType: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' },
      });
      if (step.nextStep.signInStep !== 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE') {
        throw new AuthError('not_authorized');
      }
    });
  }

  confirmCode(code: string): Observable<AuthTokens> {
    return effect(() => this.#confirm(code));
  }

  signInWithPassword(email: string, password: string): Observable<PasswordSignInStep> {
    return effect(async (): Promise<PasswordSignInStep> => {
      const step = await signIn({
        username: email,
        password,
        options: { authFlowType: 'USER_AUTH', preferredChallenge: 'PASSWORD_SRP' },
      });
      if (step.isSignedIn) return { kind: 'signed_in', tokens: await currentTokens() };
      if (step.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') {
        return { kind: 'totp_required' };
      }
      throw new AuthError('not_authorized');
    });
  }

  confirmTotp(code: string): Observable<AuthTokens> {
    return effect(() => this.#confirm(code));
  }

  startSetup(input: SetupInput): Observable<TotpEnrolment> {
    return effect(async () => {
      const step = await signIn({
        username: input.email,
        password: input.code,
        options: { authFlowType: 'USER_AUTH', preferredChallenge: 'PASSWORD' },
      });
      if (step.nextStep.signInStep !== 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        throw new AuthError('not_authorized');
      }
      const next = await confirmSignIn({ challengeResponse: input.password });
      if (!next.isSignedIn) throw new AuthError('not_authorized');
      const totp = await setUpTOTP();
      return {
        secret: totp.sharedSecret,
        otpauthUri: totp.getSetupUri(TOTP_ISSUER, input.email).toString(),
      };
    });
  }

  verifyTotpSetup(code: string): Observable<AuthTokens> {
    return effect(async () => {
      await verifyTOTPSetup({ code });
      await updateMFAPreference({ totp: 'PREFERRED' });
      return currentTokens();
    });
  }

  restore(): Observable<AuthTokens | null> {
    return effect(async () => {
      const session = await fetchAuthSession();
      return tokensOf(session.tokens);
    });
  }

  refresh(): Observable<AuthTokens> {
    return effect(async () => {
      const session = await fetchAuthSession({ forceRefresh: true });
      const tokens = tokensOf(session.tokens);
      if (!tokens) throw new AuthError('not_authorized');
      return tokens;
    });
  }

  signOut(): Observable<void> {
    return effect(() => signOut());
  }

  async #confirm(code: string): Promise<AuthTokens> {
    const step = await confirmSignIn({ challengeResponse: code });
    if (!step.isSignedIn) throw new AuthError('code_mismatch');
    return currentTokens();
  }
}

async function currentTokens(): Promise<AuthTokens> {
  const tokens = tokensOf((await fetchAuthSession()).tokens);
  if (!tokens) throw new AuthError('not_authorized');
  return tokens;
}

function tokensOf(
  tokens: { accessToken: { toString(): string }; idToken?: { toString(): string } } | undefined,
): AuthTokens | null {
  if (!tokens?.idToken) return null;
  return { accessToken: tokens.accessToken.toString(), idToken: tokens.idToken.toString() };
}

/** A promise-returning Amplify call as a cold Observable, its exceptions mapped. */
function effect<T>(run: () => Promise<T>): Observable<T> {
  return defer(() =>
    from(
      run().catch((error: unknown) => {
        throw mapAmplifyError(error);
      }),
    ),
  );
}

/** Cognito exception names → `AuthErrorCode`; anything else stays unexpected. */
function mapAmplifyError(error: unknown): unknown {
  if (error instanceof AuthError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  switch (name) {
    case 'CodeMismatchException':
    case 'EnableSoftwareTokenMFAException':
      return new AuthError('code_mismatch', { cause: error });
    case 'ExpiredCodeException':
      return new AuthError('code_expired', { cause: error });
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException':
    case 'LimitExceededException':
      return new AuthError('too_many_attempts', { cause: error });
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
    case 'UserNotConfirmedException':
    case 'PasswordResetRequiredException':
      return new AuthError('not_authorized', { cause: error });
    case 'InvalidPasswordException':
      return new AuthError('invalid_password', { cause: error });
    default:
      return error;
  }
}
