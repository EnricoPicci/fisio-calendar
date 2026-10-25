import type { Clock } from '@fisio/domain';
import {
  catchError,
  defer,
  distinctUntilChanged,
  finalize,
  map,
  type Observable,
  of,
  Subject,
  share,
} from 'rxjs';
import { ViewModel } from '../app/view-model';
import type { AuthService, AuthTokens } from '../services/auth-service';
import { decodeJwtClaims } from '../services/jwt';

/**
 * The signed-in state of the app (docs/architecture.md §8.1 "stay signed in on the device",
 * §10.4 C1 "token expires mid-session → silent refresh keeps the user signed in").
 *
 * - `page$`: which page the shell shows: `loading` until `restore()` has answered, `signIn` when
 *   nobody is signed in, otherwise the signed-in role.
 * - `accessToken$`: subscribed by the `ApiClient` before every request. It emits the current
 *   access token, or a freshly refreshed one when the current one is within
 *   {@link REFRESH_SKEW_SECONDS} of its expiry at the `Clock`; concurrent requests share one
 *   refresh. A refused refresh ends the session: `null` is emitted and `signedOut$` explains.
 * - `signedOut$`: why the session ended (`user` or `refresh_refused`), for the shell's notice.
 */
export type SessionPage = 'loading' | 'signIn' | 'client' | 'therapist';
export type SignOutReason = 'user' | 'refresh_refused';

/** A token this close to expiry is refreshed before use, so a request never carries a dead one. */
export const REFRESH_SKEW_SECONDS = 30;

/** What the sign-in and setup view-models need from the session. */
export interface SessionSink {
  start(tokens: AuthTokens): void;
}

export class SessionViewModel extends ViewModel implements SessionSink {
  readonly #auth: AuthService;
  readonly #clock: Clock;
  /** `undefined` until `restore()` has answered; `null` when nobody is signed in. */
  readonly #tokens = this.state<AuthTokens | null | undefined>(undefined);
  readonly #signedOut = new Subject<SignOutReason>();
  #refreshing: Observable<string | null> | undefined;

  readonly page$ = this.stream('page$', this.#tokens.pipe(map(pageOf), distinctUntilChanged()));
  readonly accessToken$ = this.stream(
    'accessToken$',
    defer(() => this.#currentToken()),
  );
  readonly signedOut$ = this.stream('signedOut$', this.#signedOut.asObservable());

  constructor(auth: AuthService, clock: Clock) {
    super();
    this.#auth = auth;
    this.#clock = clock;
    this.own(() => this.#signedOut.complete());
  }

  /** A sign-in or setup flow completed: the session starts with its tokens. */
  start(tokens: AuthTokens): void {
    this.#tokens.next(tokens);
  }

  /** On app start: resumes the sign-in kept on this device, if any. */
  restore(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.own(
        this.#auth
          .restore()
          .pipe(catchError(() => of(null)))
          .subscribe({
            next: (tokens) => this.#tokens.next(tokens),
            complete: resolve,
            error: () => resolve(),
          }),
      );
    });
  }

  /** Ends the session on this device, whether or not the provider could be told. */
  signOut(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.own(
        this.#auth
          .signOut()
          .pipe(catchError(() => of(undefined)))
          .subscribe({
            complete: () => {
              this.#end('user');
              resolve();
            },
            error: () => resolve(),
          }),
      );
    });
  }

  #currentToken(): Observable<string | null> {
    const tokens = this.#tokens.value;
    if (!tokens) return of(null);
    if (!this.#expiresSoon(tokens)) return of(tokens.accessToken);
    return this.#refresh();
  }

  /** One refresh at a time: every subscriber waiting on it gets the same answer. */
  #refresh(): Observable<string | null> {
    this.#refreshing ??= this.#auth.refresh().pipe(
      map((tokens) => {
        this.#tokens.next(tokens);
        return tokens.accessToken;
      }),
      catchError(() => {
        this.#end('refresh_refused');
        return of(null);
      }),
      finalize(() => {
        this.#refreshing = undefined;
      }),
      share(),
    );
    return this.#refreshing;
  }

  #end(reason: SignOutReason): void {
    this.#tokens.next(null);
    this.#signedOut.next(reason);
  }

  #expiresSoon(tokens: AuthTokens): boolean {
    const exp = decodeJwtClaims(tokens.accessToken).exp;
    if (typeof exp !== 'number') return false;
    return exp * 1000 <= this.#clock.now().getTime() + REFRESH_SKEW_SECONDS * 1000;
  }
}

function pageOf(tokens: AuthTokens | null | undefined): SessionPage {
  if (tokens === undefined) return 'loading';
  if (tokens === null) return 'signIn';
  return decodeJwtClaims(tokens.accessToken).role === 'therapist' ? 'therapist' : 'client';
}
