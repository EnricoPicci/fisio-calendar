import { isAuthErrorCode } from '@fisio/contracts';
import { defer, from, map, type Observable, of, throwError } from 'rxjs';
import { z } from 'zod';
import {
  AuthError,
  type AuthService,
  type AuthTokens,
  type PasswordSignInStep,
  type SetupInput,
  type TotpEnrolment,
} from './auth-service';
import { fetchOrNetworkError } from './network-error';
import type { Storage } from './storage';

/**
 * The `AuthService` of the local build (docs/architecture.md §11.4): the auth emulator's HTTP
 * routes (tools/local/auth-emulator/README.md), with the emulator's session id kept between the
 * two steps of a sign-in and the tokens, refresh token included, kept in the `Storage` port. The
 * headless journeys give it the testkit's in-process fetch, so the same class runs against the
 * emulator's Hono app without a server.
 *
 * A refused step answers 400 `{ code }` with an `AuthErrorCode`, mapped to {@link AuthError}.
 * A failed network round trip is a `NetworkError`. Any other failure (a code outside the list,
 * a body that does not match the route's shape) is unexpected and surfaces as a plain `Error`.
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

const EmulatorTokens = z.object({
  accessToken: z.string().min(1),
  idToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number(),
});
type EmulatorTokens = z.infer<typeof EmulatorTokens>;

const EmulatorStep = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('challenge'), challenge: z.string(), session: z.string().min(1) }),
  z.object({ kind: z.literal('signedIn'), tokens: EmulatorTokens }),
]);

const EmulatorEnrolment = z.object({
  session: z.string().min(1),
  secret: z.string().min(1),
  otpauthUri: z.string().min(1),
});

const StoredTokens = EmulatorTokens.omit({ expiresIn: true });
type StoredTokens = z.infer<typeof StoredTokens>;

/**
 * What a refused refresh leaves behind instead of the dead pair: `restore()` reads it as
 * nobody, and a refresh of the same pair that another tab wins meanwhile can tell this
 * marker (keep the rotated pair) from a sign-out (the key is gone: stay signed out).
 */
const SpentMarker = z.object({ spent: z.string().min(1) });

export class LocalAuthService implements AuthService {
  readonly #issuer: string;
  readonly #fetch: typeof fetch;
  readonly #storage: Storage;
  /** The emulator session of the sign-in in progress, between its two steps. */
  #session: string | undefined;
  /** Set by `signOut()`, cleared by the next pair kept: a refresh in flight must not undo it. */
  #signedOut = false;

  constructor(options: LocalAuthServiceOptions) {
    this.#issuer = options.issuer.replace(/\/+$/, '');
    this.#fetch = options.fetch;
    this.#storage = options.storage;
  }

  requestCode(email: string): Observable<void> {
    return this.#post('/email-otp', { email }, EmulatorStep).pipe(
      map((step) => {
        this.#session = step.kind === 'challenge' ? step.session : undefined;
      }),
    );
  }

  confirmCode(code: string): Observable<AuthTokens> {
    return this.#answer('/email-otp/answer', code);
  }

  signInWithPassword(email: string, password: string): Observable<PasswordSignInStep> {
    return this.#post('/password', { email, password }, EmulatorStep).pipe(
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
    return this.#post('/setup', { code, password }, EmulatorEnrolment).pipe(
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
      return of(stored ? pick(stored) : null);
    });
  }

  /**
   * The whole round trip runs inside one promise, so an unsubscribed caller cannot lose the
   * rotated refresh token: the emulator spends the old one whatever happens to the answer.
   * The storage is shared by every tab of the device: a tab that finds the pair already
   * rotated by another one adopts the stored pair; a tab that finds the key removed (a sign-out
   * in this or another tab) stays signed out; a refused refresh leaves a spent marker, not the
   * dead pair.
   */
  refresh(): Observable<AuthTokens> {
    return defer(() => {
      const stored = this.#stored();
      if (!stored) return throwError(() => new AuthError('not_authorized'));
      return from(this.#refreshWith(stored));
    });
  }

  signOut(): Observable<void> {
    return defer(() => {
      this.#storage.remove(LOCAL_TOKENS_KEY);
      this.#session = undefined;
      this.#signedOut = true;
      return of(undefined);
    });
  }

  async #refreshWith(stored: StoredTokens): Promise<AuthTokens> {
    try {
      const tokens = await this.#call(
        '/refresh',
        { refreshToken: stored.refreshToken },
        EmulatorTokens,
      );
      // A sign-out meanwhile, in this tab or another: the device must stay signed out.
      if (this.#signedOut || this.#storage.get(LOCAL_TOKENS_KEY) === null) {
        throw new AuthError('not_authorized');
      }
      const now = this.#stored();
      // Another tab rotated first: its pair is the live one, this answer is a dead end.
      if (now && now.refreshToken !== stored.refreshToken) return pick(now);
      return this.#keep(tokens);
    } catch (error) {
      if (error instanceof AuthError) {
        const now = this.#stored();
        // Another tab already rotated the pair this call was refused for: use it.
        if (now && now.refreshToken !== stored.refreshToken) return pick(now);
        // The emulator spends a refresh token it refuses: leave a marker in place of the
        // dead pair, so a tab whose refresh of the same pair wins can still keep its answer.
        if (now?.refreshToken === stored.refreshToken) {
          this.#storage.set(LOCAL_TOKENS_KEY, JSON.stringify({ spent: stored.refreshToken }));
        }
      }
      throw error;
    }
  }

  /** The second step of a flow: needs the session of the first, which it spends on success. */
  #answer(path: string, code: string): Observable<AuthTokens> {
    return defer(() => {
      const session = this.#session;
      if (!session) return throwError(() => new AuthError('invalid_session'));
      return this.#post(path, { session, code }, EmulatorTokens).pipe(
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
    this.#signedOut = false;
    return pick(stored);
  }

  #stored(): StoredTokens | undefined {
    const raw = this.#storage.get(LOCAL_TOKENS_KEY);
    if (!raw) return undefined;
    try {
      const parsed = StoredTokens.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  #post<T>(path: string, body: Record<string, string>, shape: z.ZodType<T>): Observable<T> {
    return defer(() => from(this.#call(path, body, shape)));
  }

  async #call<T>(path: string, body: Record<string, string>, shape: z.ZodType<T>): Promise<T> {
    const response = await fetchOrNetworkError(this.#fetch, `${this.#issuer}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
      const parsed = shape.safeParse(json);
      if (parsed.success) return parsed.data;
      throw new Error(`The auth emulator answered ${path} with an unexpected body`);
    }
    const code = (json as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string' && isAuthErrorCode(code)) throw new AuthError(code);
    throw new Error(`The auth emulator answered ${response.status} ${String(code ?? '')}`);
  }
}

/** True when the storage holds the spent marker a refused refresh leaves. */
export function isSpentMarker(raw: string | null): boolean {
  if (!raw) return false;
  try {
    return SpentMarker.safeParse(JSON.parse(raw)).success;
  } catch {
    return false;
  }
}

function pick(stored: StoredTokens): AuthTokens {
  return { accessToken: stored.accessToken, idToken: stored.idToken };
}
