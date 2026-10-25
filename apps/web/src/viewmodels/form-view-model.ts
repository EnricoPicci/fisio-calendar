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
 * effect has settled either way and never rejects.
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
   * Runs `effect$` (one value, then complete) with busy/error bookkeeping. `onValue` applies the
   * result; `onRefused` lets a flow react to a sign-in code (for example going back a step).
   */
  protected attempt<T>(
    effect: () => Observable<T>,
    onValue: (value: T) => void,
    onRefused?: (code: AuthErrorCode) => void,
  ): Promise<void> {
    if (this.busy.value) return Promise.resolve();
    this.busy.next(true);
    this.error.next(null);
    return new Promise<void>((resolve) => {
      this.own(
        effect()
          .pipe(take(1))
          .subscribe({
            next: (value) => {
              onValue(value);
              this.busy.next(false);
            },
            error: (error: unknown) => {
              this.error.next(messageFor(error, this.strings));
              if (error instanceof AuthError) onRefused?.(error.code);
              this.busy.next(false);
              resolve();
            },
            complete: () => {
              if (this.busy.value) this.busy.next(false);
              resolve();
            },
          }),
      );
    });
  }
}
