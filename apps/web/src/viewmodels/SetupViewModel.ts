import type { Strings } from '@fisio/contracts';
import type { AuthService } from '../services/auth-service';
import { FormViewModel } from './form-view-model';
import type { SessionSink } from './SessionViewModel';

/**
 * The therapist's one-time setup page (docs/architecture.md §11.5, §15): the bootstrap CLI's link
 * `/setup#email=…&code=…` opens it. Step `password` takes the new password and starts the TOTP
 * enrolment; step `totp` shows the secret (`enrolment$`) and takes the first authenticator code;
 * only then is the setup done and the session started (a password alone never counts).
 *
 * A wrong first code keeps the enrolment open for another try. Any other refusal at the code
 * step (a lockout, which outlives the enrolment session; the session expired; the setup code was
 * replaced by a bootstrap re-run) ends it: back to the password step with the dead secret
 * dropped, so the therapist starts again from the same link instead of typing codes that can
 * never be accepted.
 */
export type SetupStep = 'password' | 'totp' | 'done';

export interface SetupEnrolment {
  /** Base32, for authenticator apps that take the key by hand. */
  readonly secret: string;
  /** The `otpauth://` link, when the provider gave a well-formed one. */
  readonly otpauthUri: string | undefined;
}

export class SetupViewModel extends FormViewModel {
  readonly #auth: AuthService;
  readonly #session: SessionSink;
  readonly #step = this.state<SetupStep>('password');
  readonly #enrolment = this.state<SetupEnrolment | null>(null);

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
        this.#enrolment.next({
          secret: enrolment.secret,
          otpauthUri: /^otpauth:/i.test(enrolment.otpauthUri) ? enrolment.otpauthUri : undefined,
        });
        this.#step.next('totp');
      },
      (refused) => (refused === 'not_authorized' ? this.strings.setup.linkUsed : undefined),
    );
  }

  verifyTotp(code: string): Promise<void> {
    return this.attempt(
      () => this.#auth.verifyTotpSetup(code),
      (tokens) => {
        this.#session.start(tokens);
        this.#step.next('done');
      },
      (refused) => {
        if (refused === 'code_mismatch') return undefined;
        // A lockout outlives the enrolment session, so the secret on screen is dead too.
        this.#enrolment.next(null);
        this.#step.next('password');
        return refused === 'too_many_attempts' ? undefined : this.strings.setup.enrolmentEnded;
      },
    );
  }
}
