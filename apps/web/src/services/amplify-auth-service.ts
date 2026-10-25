import { Amplify } from 'aws-amplify';
import {
  confirmSignIn,
  fetchAuthSession,
  fetchMFAPreference,
  setUpTOTP,
  signIn,
  signOut,
  updateMFAPreference,
  verifyTOTPSetup,
} from 'aws-amplify/auth';
import { defer, from, type Observable } from 'rxjs';
import { isAlreadyAuthenticated, mapAmplifyError, tokensOf } from './amplify-errors';
import {
  AuthError,
  type AuthService,
  type AuthTokens,
  type PasswordSignInStep,
  type SetupInput,
  type TotpEnrolment,
} from './auth-service';
import { decodeJwtClaims } from './jwt';

/**
 * The `AuthService` of the cloud build (docs/architecture.md §8.1): Amplify Auth against the
 * Cognito pool. Clients: `USER_AUTH` with `EMAIL_OTP` as the preferred challenge; the email step
 * answers the same whatever Cognito says about the address (a lockout excepted, which is no
 * enumeration signal), and the code step then fails as a wrong code without a round trip (C1).
 * Therapist: password (SRP) followed by the `SOFTWARE_TOKEN_MFA` challenge Cognito issues while
 * TOTP is her preferred MFA.
 *
 * The setup link signs in with the temporary password, answers `NEW_PASSWORD_REQUIRED`, then
 * enrols TOTP and makes it preferred (§15: a password alone never counts as a finished setup).
 * Cognito completes that sign-in before the enrolment, and Amplify keeps its tokens; so a setup
 * that fails after the password step signs out again, and no path hands out a therapist session
 * whose TOTP is not enabled: every token issuance, `restore()` and `refresh()` go through the
 * same guard, whose positive answer is remembered per access token. The server-side control is
 * WP0.9's (TODOS.md).
 *
 * Amplify keeps and refreshes the tokens itself; `refresh()` forces one. A sign-in started
 * while Amplify still holds a user (the app refused its tokens, or an offline restore) signs
 * that user out and retries once. Cognito's exceptions are mapped onto `AuthErrorCode` (D28).
 * Verified against the real pool only on `dev` (WP0.10 spike, implementation plan §9): until
 * then the flow names and the exception names are the documented ones.
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
  /** True when the last `requestCode()` was refused by Cognito: no sign-in is in progress. */
  #codeRefused = false;
  /** The access token whose therapist has TOTP enabled: one `fetchMFAPreference` per token pair. */
  #enrolledToken: string | undefined;

  requestCode(email: string): Observable<void> {
    return effect(async () => {
      this.#codeRefused = false;
      try {
        const step = await freshSignIn(() =>
          signIn({
            username: email,
            options: { authFlowType: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' },
          }),
        );
        if (step.nextStep.signInStep !== 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE') {
          // A sign-in Cognito completed without the code step must not stay with Amplify.
          if (step.isSignedIn) await signOut().catch(() => undefined);
          throw new AuthError('not_authorized');
        }
      } catch (error) {
        const mapped = mapAmplifyError(error);
        if (!(mapped instanceof AuthError)) throw error;
        // A lockout is worth telling; any other refusal answers like a client's address, and
        // the reason is not logged either: the console is one more channel to the same person.
        if (mapped.code === 'too_many_attempts') throw mapped;
        console.warn('[auth] code request refused');
        this.#codeRefused = true;
      }
    });
  }

  confirmCode(code: string): Observable<AuthTokens> {
    return effect(async () => {
      // No sign-in in progress: answer as for a wrong code, without a call that would differ.
      if (this.#codeRefused) throw new AuthError('code_mismatch');
      return this.#confirm(code);
    });
  }

  signInWithPassword(email: string, password: string): Observable<PasswordSignInStep> {
    return effect(async (): Promise<PasswordSignInStep> => {
      const step = await freshSignIn(() =>
        signIn({
          username: email,
          password,
          options: { authFlowType: 'USER_AUTH', preferredChallenge: 'PASSWORD_SRP' },
        }),
      );
      if (step.isSignedIn) return { kind: 'signed_in', tokens: await this.#currentTokens() };
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
      try {
        const step = await freshSignIn(() =>
          signIn({
            username: input.email,
            password: input.code,
            options: { authFlowType: 'USER_AUTH', preferredChallenge: 'PASSWORD' },
          }),
        );
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
      } catch (error) {
        // A step may already have signed her in: never leave a single-factor session.
        await signOut().catch(() => undefined);
        throw error;
      }
    });
  }

  verifyTotpSetup(code: string): Observable<AuthTokens> {
    return effect(async () => {
      try {
        await verifyTOTPSetup({ code });
        await updateMFAPreference({ totp: 'PREFERRED' });
      } catch (error) {
        // A wrong code keeps the enrolment open for another try, and so does a failure that
        // never reached Cognito; any other refusal ends it, so the single-factor session
        // Cognito completed at the password step does not outlive the enrolment.
        const mapped = mapAmplifyError(error);
        if (mapped instanceof AuthError && mapped.code !== 'code_mismatch') {
          await signOut().catch(() => undefined);
        }
        throw error;
      }
      return this.#currentTokens();
    });
  }

  restore(): Observable<AuthTokens | null> {
    return effect(async () => {
      const session = await fetchAuthSession();
      return this.#enrolledOnly(tokensOf(session.tokens));
    });
  }

  refresh(): Observable<AuthTokens> {
    return effect(async () => {
      const session = await fetchAuthSession({ forceRefresh: true });
      const tokens = await this.#enrolledOnly(tokensOf(session.tokens));
      if (!tokens) throw new AuthError('not_authorized');
      return tokens;
    });
  }

  signOut(): Observable<void> {
    return effect(async () => {
      this.#enrolledToken = undefined;
      await signOut();
    });
  }

  async #confirm(code: string): Promise<AuthTokens> {
    const step = await confirmSignIn({ challengeResponse: code });
    if (!step.isSignedIn) throw new AuthError('code_mismatch');
    return this.#currentTokens();
  }

  /** The tokens of the sign-in just completed, through the TOTP guard. */
  async #currentTokens(): Promise<AuthTokens> {
    const tokens = await this.#enrolledOnly(tokensOf((await fetchAuthSession()).tokens));
    if (!tokens) throw new AuthError('not_authorized');
    return tokens;
  }

  /** A therapist session counts only with TOTP enabled; anything else is signed out. */
  async #enrolledOnly(tokens: AuthTokens | null): Promise<AuthTokens | null> {
    if (!tokens || decodeJwtClaims(tokens.accessToken).role !== 'therapist') return tokens;
    if (this.#enrolledToken === tokens.accessToken) return tokens;
    const preference = await fetchMFAPreference();
    if (preference.enabled?.includes('TOTP')) {
      this.#enrolledToken = tokens.accessToken;
      return tokens;
    }
    await signOut().catch(() => undefined);
    return null;
  }
}

/** A sign-in that Amplify refuses because a user is still held: sign out, retry once. */
async function freshSignIn<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isAlreadyAuthenticated(error)) throw error;
    await signOut().catch(() => undefined);
    return run();
  }
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
