import type { Strings } from '@fisio/contracts';
import type { AuthService } from '../services/auth-service';
import { FormViewModel } from './form-view-model';
import type { SessionSink } from './SessionViewModel';

/**
 * The sign-in page (docs/architecture.md §3.3 C1 clients, T1 therapist; §7.2). One view-model
 * for both flows, the step deciding which form the template shows:
 *
 * - `email` → `requestCode(email)` → `code` → `confirmCode(code)` → session started.
 * - `password` → `signInWithPassword(email, password)` → `totp` → `confirmTotp(code)` → session.
 *
 * A wrong code stays on its step; an expired code or a lockout goes back to the first step of
 * the flow, since the code can no longer be used; `error$` says why in Italian.
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
      (tokens) => this.#session.start(tokens),
      (refused) => {
        if (refused !== 'code_mismatch') this.#step.next('email');
      },
    );
  }

  signInWithPassword(email: string, password: string): Promise<void> {
    return this.attempt(
      () => this.#auth.signInWithPassword(email, password),
      (step) => {
        if (step.kind === 'signed_in') this.#session.start(step.tokens);
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
    this.error.next(null);
    this.#step.next(step);
  }
}
