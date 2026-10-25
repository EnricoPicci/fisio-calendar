import { isAuthErrorCode } from '@fisio/contracts';
import { catchError, defer, from, map, type Observable, of, switchMap, throwError } from 'rxjs';
import {
  AuthError,
  type AuthService,
  type AuthTokens,
  type PasswordSignInStep,
  type SetupInput,
  type TotpEnrolment,
} from './auth-service';
import type { Storage } from './storage';

/**
 * The `AuthService` of the local build (docs/architecture.md §11.4): the auth emulator's HTTP
 * routes (tools/local/auth-emulator/README.md), with the emulator's session id kept between the
 * two steps of a sign-in and the tokens, refresh token included, kept in the `Storage` port. The
 * headless journeys give it the testkit's in-process fetch, so the same class runs against the
 * emulator's Hono app without a server.
 *
 * A refused step answers 400 `{ code }` with an `AuthErrorCode`, mapped to {@link AuthError}.
 * Any other failure (a code outside the list, a non-JSON body, a network error) is unexpected
 * and surfaces as a plain `Error`.
 */
export interface LocalAuthServiceOptions {
  /** The emulator's issuer URL, under which its routes live: `DEFAULT_EMULATOR_CONFIG.issuer`. */
  readonly issuer: string;
  readonly fetch: typeof fetch;
  readonly storage: Storage;
}

/** The `pnpm dev` emulator (`LOCAL_EMULATOR_PORT`, `LOCAL_POOL_ID` in its config). */
export const LOCAL_AUTH_ISSUER = 'http://127.0.0.1:9100/local';
export const LOCAL_TOKENS_KEY = 'fisio.local.tokens';

interface EmulatorTokens {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

type EmulatorStep =
  | { readonly kind: 'challenge'; readonly challenge: string; readonly session: string }
  | { readonly kind: 'signedIn'; readonly tokens: EmulatorTokens };

interface EmulatorEnrolment {
  readonly session: string;
  readonly secret: string;
  readonly otpauthUri: string;
}

type StoredTokens = Pick<EmulatorTokens, 'accessToken' | 'idToken' | 'refreshToken'>;

export class LocalAuthService implements AuthService {
  readonly #issuer: string;
  readonly #fetch: typeof fetch;
  readonly #storage: Storage;
  /** The emulator session of the sign-in in progress, between its two steps. */
  #session: string | undefined;

  constructor(options: LocalAuthServiceOptions) {
    this.#issuer = options.issuer.replace(/\/+$/, '');
    this.#fetch = options.fetch;
    this.#storage = options.storage;
  }

  requestCode(email: string): Observable<void> {
    return this.#post<EmulatorStep>('/email-otp', { email }).pipe(
      map((step) => {
        this.#session = step.kind === 'challenge' ? step.session : undefined;
      }),
    );
  }

  confirmCode(code: string): Observable<AuthTokens> {
    return this.#answer('/email-otp/answer', code);
  }

  signInWithPassword(email: string, password: string): Observable<PasswordSignInStep> {
    return this.#post<EmulatorStep>('/password', { email, password }).pipe(
      map((step): PasswordSignInStep => {
        if (step.kind === 'signedIn') return { kind: 'signed_in', tokens: this.#keep(step.tokens) };
        this.#session = step.session;
        return { kind: 'totp_required' };
      }),
    );
  }

  confirmTotp(code: string): Observable<AuthTokens> {
    return this.#answer('/totp/answer', code);
  }

  startSetup(input: SetupInput): Observable<TotpEnrolment> {
    const { code, password } = input;
    return this.#post<EmulatorEnrolment>('/setup', { code, password }).pipe(
      map((enrolment) => {
        this.#session = enrolment.session;
        return { secret: enrolment.secret, otpauthUri: enrolment.otpauthUri };
      }),
    );
  }

  verifyTotpSetup(code: string): Observable<AuthTokens> {
    return this.#answer('/setup/verify', code);
  }

  restore(): Observable<AuthTokens | null> {
    return defer(() => {
      const stored = this.#stored();
      return of(stored ? { accessToken: stored.accessToken, idToken: stored.idToken } : null);
    });
  }

  refresh(): Observable<AuthTokens> {
    return defer(() => {
      const stored = this.#stored();
      if (!stored) return throwError(() => new AuthError('not_authorized'));
      return this.#post<EmulatorTokens>('/refresh', { refreshToken: stored.refreshToken }).pipe(
        map((tokens) => this.#keep(tokens)),
        catchError((error: unknown) => {
          // The emulator spends a refresh token it refuses: nothing here can be reused.
          if (error instanceof AuthError) this.#storage.remove(LOCAL_TOKENS_KEY);
          return throwError(() => error);
        }),
      );
    });
  }

  signOut(): Observable<void> {
    return defer(() => {
      this.#storage.remove(LOCAL_TOKENS_KEY);
      this.#session = undefined;
      return of(undefined);
    });
  }

  /** The second step of a flow: needs the session of the first, which it spends on success. */
  #answer(path: string, code: string): Observable<AuthTokens> {
    return defer(() => {
      const session = this.#session;
      if (!session) return throwError(() => new AuthError('invalid_session'));
      return this.#post<EmulatorTokens>(path, { session, code }).pipe(
        map((tokens) => {
          this.#session = undefined;
          return this.#keep(tokens);
        }),
      );
    });
  }

  #keep(tokens: EmulatorTokens): AuthTokens {
    const stored: StoredTokens = {
      accessToken: tokens.accessToken,
      idToken: tokens.idToken,
      refreshToken: tokens.refreshToken,
    };
    this.#storage.set(LOCAL_TOKENS_KEY, JSON.stringify(stored));
    return { accessToken: tokens.accessToken, idToken: tokens.idToken };
  }

  #stored(): StoredTokens | undefined {
    const raw = this.#storage.get(LOCAL_TOKENS_KEY);
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isStoredTokens(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  #post<T>(path: string, body: Record<string, string>): Observable<T> {
    return defer(() =>
      from(
        this.#fetch(`${this.#issuer}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
    ).pipe(
      switchMap(async (response) => {
        const json: unknown = await response.json().catch(() => undefined);
        if (response.ok) return json as T;
        const code = (json as { code?: unknown } | undefined)?.code;
        if (typeof code === 'string' && isAuthErrorCode(code)) throw new AuthError(code);
        throw new Error(`The auth emulator answered ${response.status} ${String(code ?? '')}`);
      }),
    );
  }
}

function isStoredTokens(value: unknown): value is StoredTokens {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ['accessToken', 'idToken', 'refreshToken'].every(
    (key) => typeof record[key] === 'string' && record[key] !== '',
  );
}
