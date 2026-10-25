import type { AuthErrorCode } from '@fisio/contracts';
import type { Observable } from 'rxjs';

/**
 * The `AuthService` port (docs/architecture.md §7.1, §8.1): the sign-in flows the SPA runs,
 * implemented by `AmplifyAuthService` (Cognito, cloud build) and `LocalAuthService` (the auth
 * emulator, local build), selected at build time. Like the `ApiClient`, every method returns an
 * Observable, so view-model effects are pipelines and marble specs drive them in virtual time;
 * each emits exactly one value and completes, or errors with an {@link AuthError}.
 *
 * The service is stateful across the steps of one sign-in (Cognito's SDK keeps the session, the
 * emulator's session id is kept here) and owns the persistence of its tokens: `restore()` on
 * app start, `refresh()` when the session asks for a new access token.
 */
export interface AuthService {
  /**
   * Client flow, step one: `USER_AUTH` / `EMAIL_OTP`. Succeeds for any address, known or not (no
   * account enumeration); the one refusal is `too_many_attempts` for a locked account, which
   * Cognito raises at this step and the emulator at the code step.
   */
  requestCode(email: string): Observable<void>;
  /** Client flow, step two: the 8-digit code from the email. */
  confirmCode(code: string): Observable<AuthTokens>;
  /** Therapist flow, step one: password; always followed by the TOTP challenge once enrolled. */
  signInWithPassword(email: string, password: string): Observable<PasswordSignInStep>;
  /** Therapist flow, step two: the 6-digit code of the authenticator app. */
  confirmTotp(code: string): Observable<AuthTokens>;
  /** The setup link (§11.5), step one: the one-time code and the new password → a TOTP secret. */
  startSetup(input: SetupInput): Observable<TotpEnrolment>;
  /** The setup link, step two: the first authenticator code proves the enrolment. */
  verifyTotpSetup(code: string): Observable<AuthTokens>;
  /** The tokens of a previous sign-in on this device, or null. */
  restore(): Observable<AuthTokens | null>;
  /** New tokens from the refresh token; `not_authorized` when refused (revoked, expired, none). */
  refresh(): Observable<AuthTokens>;
  /** Forgets the tokens on this device (and ends the session at the provider when it can). */
  signOut(): Observable<void>;
}

export interface AuthTokens {
  readonly accessToken: string;
  readonly idToken: string;
}

export type PasswordSignInStep =
  | { readonly kind: 'totp_required' }
  | { readonly kind: 'signed_in'; readonly tokens: AuthTokens };

export interface TotpEnrolment {
  /** Base32, for authenticator apps that take the key by hand. */
  readonly secret: string;
  readonly otpauthUri: string;
}

export interface SetupInput {
  readonly email: string;
  /** The one-time code of the bootstrap link (Cognito: the temporary password). */
  readonly code: string;
  readonly password: string;
}

/** A refused sign-in step, with the code the view-models map to an Italian message. */
export class AuthError extends Error {
  override readonly name = 'AuthError';

  constructor(
    readonly code: AuthErrorCode,
    options?: { cause?: unknown },
  ) {
    super(`Sign-in refused: ${code}`, options);
  }
}
