import type { MeResponse, Strings } from '@fisio/contracts';
import { catchError, defer, map, of, shareReplay } from 'rxjs';
import { ViewModel } from '../app/view-model';
import type { ApiClient } from '../services/api-client';
import { messageFor } from './errors';

/**
 * The home page of either role (docs/architecture.md §7.2; WP0.7 placeholders until the
 * calendar and dashboard arrive). `welcome$` greets the caller by name from `GET /me`, the first
 * authenticated request of the app: subscribing to it is what proves the bearer path end to end.
 * The request runs once per view-model and is shared by every subscriber. When it fails, the
 * greeting falls back to the plain word while `error$` says what went wrong, so the heading
 * never stays on the loading text.
 */
export class HomeViewModel extends ViewModel {
  readonly #error = this.state<string | null>(null);
  readonly welcome$;
  readonly error$ = this.stream('error$', this.#error);

  constructor(api: ApiClient, strings: Strings) {
    super();
    this.welcome$ = this.stream(
      'welcome$',
      defer(() => api.me()).pipe(
        map((me) => greeting(me, strings)),
        catchError((error: unknown) => {
          this.#error.next(messageFor(error, strings));
          return of(strings.home.greeting);
        }),
        shareReplay({ bufferSize: 1, refCount: true }),
      ),
    );
  }
}

function greeting(me: MeResponse, strings: Strings): string {
  return me.role === 'client'
    ? `${strings.home.greeting}, ${me.name}`
    : strings.home.greetingTherapist;
}
