import type { Strings } from '@fisio/contracts';
import type { AuthService, TotpEnrolment } from '../services/auth-service';
import { FormViewModel } from './form-view-model';
import type { SessionSink } from './SessionViewModel';

/**
 * The therapist's one-time setup page (docs/architecture.md §11.5, §15): the bootstrap CLI's link
 * `/setup#email=…&code=…` opens it. Step `password` takes the new password and starts the TOTP
 * enrolment; step `totp` shows the secret (`enrolment$`) and takes the first authenticator code;
 * only then is the setup done and the session started (a password alone never counts).
 */
export type SetupStep = 'password' | 'totp' | 'done';

export class SetupViewModel extends FormViewModel {
  readonly #auth: AuthService;
  readonly #session: SessionSink;
  readonly #step = this.state<SetupStep>('password');
  readonly #enrolment = this.state<TotpEnrolment | null>(null);

  readonly step$ = this.stream('step$', this.#step);
  readonly enrolment$ = this.stream('enrolment$', this.#enrolment);

  constructor(auth: AuthService, session: SessionSink, strings: Strings) {
    super(strings);
    this.#auth = auth;
    this.#session = session;
  }

  /** `link` is the URL fragment of the setup link (`#email=…&code=…`), as the router hands it over. */
  startSetup(link: string, password: string): Promise<void> {
    const params = new URLSearchParams(link.replace(/^#/, ''));
    const email = params.get('email');
    const code = params.get('code');
    if (!email || !code) {
      this.error.next(this.strings.setup.invalidLink);
      return Promise.resolve();
    }
    return this.attempt(
      () => this.#auth.startSetup({ email, code, password }),
      (enrolment) => {
        this.#enrolment.next(enrolment);
        this.#step.next('totp');
      },
    );
  }

  verifyTotp(code: string): Promise<void> {
    return this.attempt(
      () => this.#auth.verifyTotpSetup(code),
      (tokens) => {
        this.#session.start(tokens);
        this.#step.next('done');
      },
    );
  }
}
