import type { Clock } from '@fisio/domain';
import {
  catchError,
  defer,
  distinctUntilChanged,
  filter,
  finalize,
  map,
  type Observable,
  of,
  Subject,
  share,
  switchMap,
  take,
} from 'rxjs';
import { ViewModel } from '../app/view-model';
import { AuthError, type AuthService, type AuthTokens } from '../services/auth-service';
import { decodeJwtClaims } from '../services/jwt';

/**
 * The signed-in state of the app (docs/architecture.md §8.1 "stay signed in on the device",
 * §10.4 C1 "token expires mid-session → silent refresh keeps the user signed in").
 *
 * - `page$`: which page the shell shows: `loading` until `restore()` has answered, `signIn` when
 *   nobody is signed in, otherwise the signed-in role.
 * - `accessToken$`: subscribed by the `ApiClient` before every request. It waits for
 *   `restore()`, then emits the current access token, or a freshly refreshed one when the
 *   current one is within {@link REFRESH_SKEW_SECONDS} of its expiry at the `Clock`; concurrent
 *   requests share one refresh, and a refresh runs to completion even when every request that
 *   waited on it was cancelled (a rotated refresh token must never be lost). A refresh the
 *   provider refuses ends the session: `null` is emitted and `signedOut$` explains. A refresh
 *   that fails for any other reason (offline) yields `null` for that request only and keeps the
 *   session. A refresh or a restore that answers after the session changed hands (sign-out, a
 *   new sign-in) is dropped.
 * - `signedOut$`: why the session ended (`user` or `refresh_refused`), for the shell's notice.
 *
 * The access token must name a role the app knows: `start()` refuses one that does not (the
 * calling form shows the unexpected-error text), `restore()` and a refresh treat it as nobody.
 */
export type SessionPage = 'loading' | 'signIn' | 'client' | 'therapist';
export type SignOutReason = 'user' | 'refresh_refused';

/** A token this close to expiry is refreshed before use, so a request never carries a dead one. */
export const REFRESH_SKEW_SECONDS = 30;

/** What the sign-in and setup view-models need from the session. */
export interface SessionSink {
  start(tokens: AuthTokens): void;
}

const ROLES = new Set(['client', 'therapist']);

export class SessionViewModel extends ViewModel implements SessionSink {
  readonly #auth: AuthService;
  readonly #clock: Clock;
  /** `undefined` until `restore()` has answered; `null` when nobody is signed in. */
  readonly #tokens = this.state<AuthTokens | null | undefined>(undefined);
  readonly #signedOut = new Subject<SignOutReason>();
  /** Bumped whenever the session starts or ends: an answer from an older session is dropped. */
  #generation = 0;
  #refreshing: Observable<string | null> | undefined;

  readonly page$ = this.stream('page$', this.#tokens.pipe(map(pageOf), distinctUntilChanged()));
  readonly accessToken$ = this.stream(
    'accessToken$',
    defer(() =>
      this.#tokens.pipe(
        filter((tokens) => tokens !== undefined),
        take(1),
        switchMap((tokens) => this.#tokenFor(tokens)),
      ),
    ),
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
    const accepted = accept(tokens);
    if (!accepted) throw new Error('The access token names no role the app knows');
    this.#generation += 1;
    this.#refreshing = undefined;
    this.#tokens.next(accepted);
  }

  /** On app start: resumes the sign-in kept on this device, if any. */
  restore(): Promise<void> {
    const generation = this.#generation;
    return new Promise<void>((resolve) => {
      this.own(
        this.#auth
          .restore()
          .pipe(catchError(() => of(null)))
          .subscribe({
            next: (tokens) => {
              // A sign-in that completed meanwhile owns the session.
              if (generation !== this.#generation) return;
              this.#tokens.next(tokens ? accept(tokens) : null);
            },
            complete: resolve,
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
          }),
      );
    });
  }

  #tokenFor(tokens: AuthTokens | null): Observable<string | null> {
    if (!tokens) return of(null);
    if (!this.#expiresSoon(tokens)) return of(tokens.accessToken);
    return this.#refresh();
  }

  /** One refresh at a time, run to completion: every subscriber waiting on it gets the same answer. */
  #refresh(): Observable<string | null> {
    if (this.#refreshing) return this.#refreshing;
    const generation = this.#generation;
    const current = () => generation === this.#generation;
    const shared = this.#auth.refresh().pipe(
      map((tokens) => {
        if (!current()) return null;
        const accepted = accept(tokens);
        this.#tokens.next(accepted);
        return accepted?.accessToken ?? null;
      }),
      catchError((error: unknown) => {
        if (current() && error instanceof AuthError) this.#end('refresh_refused');
        return of(null);
      }),
      finalize(() => {
        if (this.#refreshing === shared) this.#refreshing = undefined;
      }),
      share({ resetOnRefCountZero: false }),
    );
    this.#refreshing = shared;
    return shared;
  }

  #end(reason: SignOutReason): void {
    this.#generation += 1;
    this.#refreshing = undefined;
    this.#tokens.next(null);
    this.#signedOut.next(reason);
  }

  #expiresSoon(tokens: AuthTokens): boolean {
    const exp = decodeJwtClaims(tokens.accessToken).exp;
    // A token without a usable expiry is refreshed, so the next one has a known lifetime.
    if (typeof exp !== 'number') return true;
    return exp * 1000 <= this.#clock.now().getTime() + REFRESH_SKEW_SECONDS * 1000;
  }
}

/** Tokens the app can place: the access token names a known role. Anything else is nobody. */
function accept(tokens: AuthTokens): AuthTokens | null {
  const role = decodeJwtClaims(tokens.accessToken).role;
  return typeof role === 'string' && ROLES.has(role) ? tokens : null;
}

function pageOf(tokens: AuthTokens | null | undefined): SessionPage {
  if (tokens === undefined) return 'loading';
  if (tokens === null) return 'signIn';
  return decodeJwtClaims(tokens.accessToken).role === 'therapist' ? 'therapist' : 'client';
}
