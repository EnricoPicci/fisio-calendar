import type { AuthErrorCode, Strings } from '@fisio/contracts';
import { type Observable, take } from 'rxjs';
import { ViewModel } from '../app/view-model';
import { AuthError } from '../services/auth-service';
import { messageFor } from './errors';

/**
 * A view-model with one request in flight at a time: `busy$` disables the form's actions while
 * an effect runs (no double submit: a call made while busy is ignored), `error$` carries the
 * Italian text of the last failure and clears when the next attempt starts. The `Promise<void>`
 * an attempt returns is a convenience for templates and async specs; it resolves after the
 * effect has settled either way, also when the view-model is disposed mid-flight, and never
 * rejects.
 */
export abstract class FormViewModel extends ViewModel {
  protected readonly busy = this.state(false);
  protected readonly error = this.state<string | null>(null);
  readonly busy$ = this.stream('busy$', this.busy);
  readonly error$ = this.stream('error$', this.error);
  protected readonly strings: Strings;

  protected constructor(strings: Strings) {
    super();
    this.strings = strings;
  }

  /**
   * Runs the observable `effect()` returns (one value, then complete) with busy/error
   * bookkeeping. `onValue` applies the result; a value-less completion, a throwing `onValue`
   * and an `effect()` that throws instead of returning all count as failures. `onRefused` lets
   * a flow react to a sign-in code (going back a step) and may return the message to show
   * instead of the code's default sentence.
   */
  protected attempt<T>(
    effect: () => Observable<T>,
    onValue: (value: T) => void,
    onRefused?: (code: AuthErrorCode) => string | undefined,
  ): Promise<void> {
    // A page that is gone runs no effect; a form already busy ignores the second submit.
    if (this.isDisposed() || this.busy.value) return Promise.resolve();
    this.busy.next(true);
    this.error.next(null);
    const fail = (error: unknown) => {
      const override = error instanceof AuthError ? onRefused?.(error.code) : undefined;
      this.error.next(override ?? messageFor(error, this.strings));
      this.busy.next(false);
    };
    let source$: Observable<T>;
    try {
      source$ = effect();
    } catch (error) {
      fail(error);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const subscription = source$.pipe(take(1)).subscribe({
        next: (value) => {
          try {
            onValue(value);
            this.busy.next(false);
          } catch (error) {
            fail(error);
          }
        },
        error: fail,
        complete: () => {
          if (this.busy.value) fail(new Error('The effect completed without a value'));
        },
      });
      // Settles on complete, on error and on dispose() alike.
      subscription.add(resolve);
      this.own(subscription);
    });
  }
}
