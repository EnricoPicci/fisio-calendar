import type { Strings } from '@fisio/contracts';
import { catchError, of } from 'rxjs';
import { AuthError, type AuthService, type AuthTokens } from '../services/auth-service';
import { decodeJwtClaims } from '../services/jwt';
import { FormViewModel } from './form-view-model';
import type { SessionSink } from './SessionViewModel';

/**
 * The sign-in page (docs/architecture.md §3.3 C1 clients, T1 therapist; §7.2). One view-model
 * for both flows, the step deciding which form the template shows:
 *
 * - `email` → `requestCode(email)` → `code` → `confirmCode(code)` → session started.
 * - `password` → `signInWithPassword(email, password)` → `totp` → `confirmTotp(code)` → session.
 *
 * A wrong code stays on its step; any other refusal (expired code, lockout, a session the
 * provider no longer knows, an unusable account) goes back to the first step of the flow, since
 * the step can no longer succeed; `error$` says why in Italian. A failure that is not a refusal
 * (offline, unexpected) keeps the step for a retry. The form links do nothing while a request is
 * in flight, so a settling request never lands on a form it does not belong to.
 *
 * The therapist signs in only through the TOTP step (architecture §15: a password alone never
 * counts as a finished setup): tokens naming her that arrive any other way, a password sign-in
 * the provider completed without the challenge or the client code flow, are refused as
 * `not_authorized` and the provider is signed out, whatever the `AuthService` behind the port
 * would have accepted.
 */
export type SignInStep = 'email' | 'code' | 'password' | 'totp';

export class SignInViewModel extends FormViewModel {
  readonly #auth: AuthService;
  readonly #session: SessionSink;
  readonly #step = this.state<SignInStep>('email');

  readonly step$ = this.stream('step$', this.#step);

  constructor(auth: AuthService, session: SessionSink, strings: Strings) {
    super(strings);
    this.#auth = auth;
    this.#session = session;
  }

  requestCode(email: string): Promise<void> {
    return this.attempt(
      () => this.#auth.requestCode(email),
      () => this.#step.next('code'),
    );
  }

  confirmCode(code: string): Promise<void> {
    return this.attempt(
      () => this.#auth.confirmCode(code),
      (tokens) => this.#startWithoutTotp(tokens),
      (refused) => {
        if (refused !== 'code_mismatch') this.#step.next('email');
        return undefined;
      },
    );
  }

  signInWithPassword(email: string, password: string): Promise<void> {
    return this.attempt(
      () => this.#auth.signInWithPassword(email, password),
      (step) => {
        if (step.kind === 'signed_in') this.#startWithoutTotp(step.tokens);
        else this.#step.next('totp');
      },
    );
  }

  confirmTotp(code: string): Promise<void> {
    return this.attempt(
      () => this.#auth.confirmTotp(code),
      (tokens) => this.#session.start(tokens),
      (refused) => {
        if (refused !== 'code_mismatch') this.#step.next('password');
        return undefined;
      },
    );
  }

  /** The therapist's link on the client form. */
  showTherapistSignIn(): void {
    this.#goTo('password');
  }

  /** Back to the client form, also "change email" from the code step. */
  showClientSignIn(): void {
    this.#goTo('email');
  }

  #goTo(step: SignInStep): void {
    if (this.busy.value) return;
    this.error.next(null);
    this.#step.next(step);
  }

  /** Tokens obtained without a TOTP step start a session only for a client. */
  #startWithoutTotp(tokens: AuthTokens): void {
    if (decodeJwtClaims(tokens.accessToken).role === 'therapist') {
      this.own(
        this.#auth
          .signOut()
          .pipe(
            catchError((error: unknown) => {
              console.warn('[sign-in] the provider could not be told to forget its tokens', error);
              return of(undefined);
            }),
          )
          .subscribe(),
      );
      throw new AuthError('not_authorized');
    }
    this.#session.start(tokens);
  }
}
