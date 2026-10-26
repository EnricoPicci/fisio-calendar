import type { Observable, Subscription } from 'rxjs';

/**
 * Subscribes to a stream the way a template would and keeps every value (docs/architecture.md
 * §10.5). `values` is the ordered history; `await rec.next(predicate)` waits for a value that
 * matches, looking first at the values emitted since the previous `next()` matched, so a value
 * that arrived before the call is not missed and an old one is not matched twice.
 */
export class ObservableRecorder<T> {
  readonly values: T[] = [];
  #error: unknown;
  #failed = false;
  #completed = false;
  /** Index of the first value the next `next()` may match. */
  #cursor = 0;
  readonly #waiters = new Set<() => void>();
  readonly #subscription: Subscription;

  constructor(source: Observable<T>) {
    this.#subscription = source.subscribe({
      next: (value) => {
        this.values.push(value);
        this.#wake();
      },
      error: (error: unknown) => {
        this.#error = error;
        this.#failed = true;
        this.#wake();
      },
      complete: () => {
        this.#completed = true;
        this.#wake();
      },
    });
  }

  /** The latest value; throws when nothing was emitted yet. */
  get latest(): T {
    if (this.values.length === 0) throw new Error('The stream has not emitted yet');
    return this.values.at(-1) as T;
  }

  get completed(): boolean {
    return this.#completed;
  }

  get closed(): boolean {
    return this.#subscription.closed;
  }

  /** Resolves with the next value matching `predicate` (any value by default). */
  next(predicate: (value: T) => boolean = () => true, timeoutMs = 2_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const check = (): boolean => {
        for (let at = this.#cursor; at < this.values.length; at += 1) {
          const value = this.values[at] as T;
          if (predicate(value)) {
            this.#cursor = at + 1;
            resolve(value);
            return true;
          }
        }
        if (this.#failed || this.#completed) {
          reject(
            new Error(
              `The stream ${this.#failed ? `failed (${String(this.#error)})` : 'completed'} before a matching value; seen ${JSON.stringify(this.values)}`,
            ),
          );
          return true;
        }
        return false;
      };
      if (check()) return;
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(
          new Error(
            `No matching value within ${timeoutMs} ms; seen ${JSON.stringify(this.values)}`,
          ),
        );
      }, timeoutMs);
      const waiter = () => {
        if (!check()) return;
        clearTimeout(timer);
        this.#waiters.delete(waiter);
      };
      this.#waiters.add(waiter);
    });
  }

  unsubscribe(): void {
    this.#subscription.unsubscribe();
  }

  #wake(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }
}
