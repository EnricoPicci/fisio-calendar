import { ROLES, type Role } from '@fisio/contracts';
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
  tap,
  throwError,
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
 *   provider refuses (`not_authorized`, `invalid_session`, or tokens the app cannot place) ends
 *   the session: `null` is emitted and `signedOut$` explains. So does a refresh that hands over
 *   another user's tokens (someone else signed in on this device meanwhile, on a shared phone):
 *   this tab must not carry their bearer under the old user's name, and their session is left
 *   alone. A refresh refused for a passing reason (a lockout) fails that request with the
 *   refusal and keeps the session. A refresh that
 *   fails for any other reason (offline) errors the request with that failure, so the form
 *   shows the offline text, and keeps the session. A refresh or a restore that answers after
 *   the session changed hands (sign-out, a new sign-in) is dropped.
 * - `signedOut$`: why the session ended (`user` or `refresh_refused`), for the shell's notice.
 *
 * The access token must name a role the app knows (`ROLES` of the contract): `start()` refuses
 * one that does not, and `restore()` or a refresh that hands one over ends with nobody signed
 * in. Whenever the app refuses tokens the provider still holds, the provider is signed out too,
 * so no credential the app will not use survives on the device.
 */
export type SessionPage = 'loading' | 'signIn' | Role;
export type SignOutReason = 'user' | 'refresh_refused';

/** A token this close to expiry is refreshed before use, so a request never carries a dead one. */
export const REFRESH_SKEW_SECONDS = 30;

/** What the sign-in and setup view-models need from the session. */
export interface SessionSink {
  start(tokens: AuthTokens): void;
}

const KNOWN_ROLES: ReadonlySet<string> = new Set(ROLES);
/** Refusals that end the session; any other sign-in code (a lockout) only fails the request. */
const ENDING_REFUSALS: ReadonlySet<string> = new Set(['not_authorized', 'invalid_session']);

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
    if (!accepted) {
      // The provider replaced its tokens with these: it is signed out, and a session that was
      // live on this device (a setup completed while signed in) ends with it.
      this.#forgetAtProvider();
      if (this.#tokens.value) this.#end('refresh_refused');
      throw new Error('The access token names no role the app knows');
    }
    this.#generation += 1;
    this.#refreshing = undefined;
    this.#tokens.next(accepted);
  }

  /** On app start: resumes the sign-in kept on this device, if any. */
  restore(): Promise<void> {
    const generation = this.#generation;
    const current = () => generation === this.#generation;
    return this.#run(
      this.#auth.restore().pipe(
        catchError((error: unknown) => {
          console.warn('[session] restore failed: nobody is signed in', error);
          return of(null);
        }),
        tap({
          next: (tokens) => {
            // A sign-in that completed meanwhile owns the session.
            if (!current()) return;
            const accepted = tokens ? accept(tokens) : null;
            if (tokens && !accepted) this.#forgetAtProvider();
            this.#tokens.next(accepted);
          },
          complete: () => {
            if (current() && this.#tokens.value === undefined) this.#tokens.next(null);
          },
        }),
      ),
    );
  }

  /** Ends the session on this device, whether or not the provider could be told. */
  signOut(): Promise<void> {
    return this.#run(
      this.#auth.signOut().pipe(
        catchError((error: unknown) => {
          console.warn('[session] the provider could not be told of the sign-out', error);
          return of(undefined);
        }),
        tap({ complete: () => this.#end('user') }),
      ),
    );
  }

  /** Runs an owned effect; the promise settles when it ends, also on `dispose()`. */
  #run(source$: Observable<unknown>): Promise<void> {
    return new Promise<void>((resolve) => {
      const subscription = source$.subscribe();
      subscription.add(resolve);
      this.own(subscription);
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
        if (!accepted) {
          this.#forgetAtProvider();
          this.#end('refresh_refused');
          return null;
        }
        const user = subjectOf(this.#tokens.value);
        if (user !== undefined && subjectOf(accepted) !== user) {
          this.#end('refresh_refused');
          return null;
        }
        this.#tokens.next(accepted);
        return accepted.accessToken;
      }),
      catchError((error: unknown) => {
        if (!(error instanceof AuthError)) return throwError(() => error);
        // A passing refusal (a lockout) is the request's failure, with its own sentence.
        if (!ENDING_REFUSALS.has(error.code)) return throwError(() => error);
        if (current()) this.#end('refresh_refused');
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

  /** Tokens the app refuses must not stay with the provider: sign it out, best effort. */
  #forgetAtProvider(): void {
    this.own(
      this.#auth
        .signOut()
        .pipe(
          catchError((error: unknown) => {
            console.warn('[session] the provider could not be told to forget its tokens', error);
            return of(undefined);
          }),
        )
        .subscribe(),
    );
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
  return typeof role === 'string' && KNOWN_ROLES.has(role) ? tokens : null;
}

/** Who the access token names (`sub`); `undefined` for nobody or a token without one, which binds no user. */
function subjectOf(tokens: AuthTokens | null | undefined): string | undefined {
  return tokens ? decodeJwtClaims(tokens.accessToken).sub : undefined;
}

function pageOf(tokens: AuthTokens | null | undefined): SessionPage {
  if (tokens === undefined) return 'loading';
  if (tokens === null) return 'signIn';
  return decodeJwtClaims(tokens.accessToken).role as Role;
}
