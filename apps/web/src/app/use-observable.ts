import { useMemo, useSyncExternalStore } from 'react';
import type { Observable, Subscription } from 'rxjs';

/**
 * The one way a template reads a view-model stream (docs/architecture.md §7.1). Built on
 * `useSyncExternalStore`: the component subscribes while mounted and re-renders on every
 * emission; `initial` is shown until the first value arrives (a `BehaviorSubject`-backed stream
 * delivers it synchronously). `initial` is read once per `source$`, so a literal is fine.
 * A stream is not supposed to error (view-models route failures into `error$`); one that does
 * is logged and keeps its last value instead of taking the whole shell down.
 */
export function useObservable<T>(source$: Observable<T>, initial: T): T {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `initial` is intentionally read once per source.
  const store = useMemo(() => externalStore(source$, initial), [source$]);
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

function externalStore<T>(source$: Observable<T>, initial: T) {
  let value = initial;
  let subscription: Subscription | undefined;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      subscription ??= source$.subscribe({
        next: (next) => {
          value = next;
          for (const notify of listeners) notify();
        },
        error: (error: unknown) => console.error('[useObservable] a stream errored', error),
      });
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          subscription?.unsubscribe();
          subscription = undefined;
        }
      };
    },
    snapshot: () => value,
  };
}
