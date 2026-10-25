import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs';

/**
 * The base of every view-model (docs/architecture.md §7.1, view-model contract). It gives:
 *
 * - `stream(name, source$)`: the only way to create a public observable. The result is tagged
 *   with its owner and name so the testkit's recorders (WP0.8) can log every subscription,
 *   emission and unsubscription in a journey trace, and it completes when the view-model is
 *   disposed. A name can be declared once.
 * - `state(initial)`: a `BehaviorSubject` the view-model owns, completed by `dispose()`.
 * - `own(teardown)`: a subscription or callback closed by `dispose()`.
 * - `dispose()`: completes every stream, closes every owned subscription; idempotent.
 *
 * Public surface of a subclass = readonly streams + methods returning `Promise<void>` or `void`.
 * A view-model never imports React and never touches `window`, `document` or `localStorage`.
 */
export abstract class ViewModel {
  readonly #disposed$ = new Subject<void>();
  readonly #owned = new Subscription();
  readonly #streams = new Map<string, Observable<unknown>>();
  readonly #observers = new Set<StreamObserver>();
  #disposed = false;

  /** The public observables declared so far, by name (for the surface-coverage check). */
  streamNames(): readonly string[] {
    return [...this.#streams.keys()];
  }

  isDisposed(): boolean {
    return this.#disposed;
  }

  /** Attaches a recorder to every stream of this view-model; returns the detach function. */
  observe(observer: StreamObserver): () => void {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposed$.next();
    this.#disposed$.complete();
    this.#owned.unsubscribe();
  }

  protected stream<T>(name: string, source$: Observable<T>): Observable<T> {
    if (this.#streams.has(name)) {
      throw new Error(`${this.constructor.name}: stream "${name}" is already declared`);
    }
    const tagged = new Observable<T>((subscriber) => {
      if (this.#disposed) {
        subscriber.complete();
        return;
      }
      for (const observer of this.#observers) observer.subscribed(this, name);
      const inner = source$.subscribe({
        next: (value) => {
          for (const observer of this.#observers) observer.emitted(this, name, value);
          subscriber.next(value);
        },
        error: (error: unknown) => subscriber.error(error),
        complete: () => subscriber.complete(),
      });
      const stop = this.#disposed$.subscribe(() => subscriber.complete());
      return () => {
        inner.unsubscribe();
        stop.unsubscribe();
        for (const observer of this.#observers) observer.unsubscribed(this, name);
      };
    });
    Object.defineProperty(tagged, STREAM_TAG, { value: { owner: this, name } satisfies StreamTag });
    this.#streams.set(name, tagged);
    return tagged;
  }

  protected state<T>(initial: T): BehaviorSubject<T> {
    const subject = new BehaviorSubject<T>(initial);
    this.own(() => subject.complete());
    return subject;
  }

  protected own(teardown: Subscription | (() => void)): void {
    if (this.#disposed) {
      if (teardown instanceof Subscription) teardown.unsubscribe();
      else teardown();
      return;
    }
    this.#owned.add(teardown);
  }
}

/** What the testkit attaches to record a view-model's streams in a journey trace. */
export interface StreamObserver {
  subscribed(owner: ViewModel, name: string): void;
  emitted(owner: ViewModel, name: string, value: unknown): void;
  unsubscribed(owner: ViewModel, name: string): void;
}

export interface StreamTag {
  readonly owner: ViewModel;
  readonly name: string;
}

const STREAM_TAG = Symbol('fisio.viewmodel.stream');

/** The owner and name of a stream created by `ViewModel.stream()`, or undefined for any other. */
export function streamTag(stream: Observable<unknown>): StreamTag | undefined {
  return (stream as unknown as { [STREAM_TAG]?: StreamTag })[STREAM_TAG];
}
