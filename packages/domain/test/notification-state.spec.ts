import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MINUTES,
  backoffMinutes,
  classifyError,
  type DeliveryState,
  InvalidTransitionError,
  isDue,
  isStale,
  MAX_ATTEMPTS,
  MAX_ERROR_LENGTH,
  markFailedAttempt,
  markSent,
  newPendingState,
  PermanentError,
  RetryableError,
  resetForManualRetry,
  SENDING_STALE_AFTER_MINUTES,
  startDelivery,
  sweepStale,
} from '../src/notification-state';

const T0 = new Date('2027-03-28T07:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

/** Drives one delivery attempt that the provider rejects with `error`. */
function failOnce(state: DeliveryState, now: Date, error: unknown) {
  return markFailedAttempt(startDelivery(state, now), now, error);
}

describe('S3 Delivery: notification state machine', () => {
  it('a new notification is pending and due immediately', () => {
    const state = newPendingState(T0);
    expect(state).toEqual({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
    });
    expect(isDue(state, T0)).toBe(true);
  });

  it('pending → sending → sent on provider success', () => {
    const sending = startDelivery(newPendingState(T0), at(0));
    expect(sending.status).toBe('sending');
    expect(sending.updatedAt).toBe(at(0).toISOString());

    const sent = markSent(sending, at(0.5), 'ses-msg-1');
    expect(sent).toMatchObject({
      status: 'sent',
      attempts: 0,
      providerMessageId: 'ses-msg-1',
      sentAt: at(0.5).toISOString(),
      updatedAt: at(0.5).toISOString(),
    });
    expect(sent.lastError).toBeUndefined();
  });

  it('retryable error → pending with nextAttemptAt per back-off table; attempts incremented', () => {
    expect(BACKOFF_MINUTES).toEqual([1, 5, 30, 120]);
    // One wait between each pair of attempts: the table and the limit must move together.
    expect(BACKOFF_MINUTES).toHaveLength(MAX_ATTEMPTS - 1);
    let state = newPendingState(T0);
    let now = T0;
    for (const [i, minutes] of BACKOFF_MINUTES.entries()) {
      const { state: next, alertTherapist } = failOnce(
        state,
        now,
        new RetryableError('smtp timeout'),
      );
      expect(alertTherapist).toBe(false);
      expect(next).toMatchObject({
        status: 'pending',
        attempts: i + 1,
        lastError: 'smtp timeout',
        nextAttemptAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
      });
      // Not due one millisecond early, due exactly at nextAttemptAt.
      const dueAt = new Date(next.nextAttemptAt);
      expect(isDue(next, new Date(dueAt.getTime() - 1))).toBe(false);
      expect(isDue(next, dueAt)).toBe(true);
      state = next;
      now = dueAt;
    }
  });

  it('permanent error → failed + therapist alert notification', () => {
    const { state, alertTherapist } = failOnce(
      newPendingState(T0),
      T0,
      new PermanentError('mailbox does not exist'),
    );
    expect(state).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'mailbox does not exist',
    });
    expect(alertTherapist).toBe(true);
    expect(isDue(state, at(10_000))).toBe(false);
  });

  it('attempts ≥ 5 → failed', () => {
    expect(MAX_ATTEMPTS).toBe(5);
    let state = newPendingState(T0);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      state = failOnce(state, new Date(state.nextAttemptAt), new RetryableError('busy')).state;
      expect(state.status).toBe('pending');
    }
    const last = failOnce(state, new Date(state.nextAttemptAt), new RetryableError('busy'));
    expect(last.state).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect(last.alertTherapist).toBe(true);
  });

  it('an unclassified error counts as retryable; its message is kept', () => {
    expect(classifyError(new RetryableError('x'))).toBe('retryable');
    expect(classifyError(new PermanentError('x'))).toBe('permanent');
    expect(classifyError(new Error('socket hang up'))).toBe('retryable');
    expect(classifyError('a string')).toBe('retryable');

    const { state } = failOnce(newPendingState(T0), T0, new Error('socket hang up'));
    expect(state).toMatchObject({ status: 'pending', attempts: 1, lastError: 'socket hang up' });
    expect(failOnce(newPendingState(T0), T0, 42).state.lastError).toBe('42');
  });

  it('a sent notification does not keep the error of an earlier attempt', () => {
    const retried = failOnce(newPendingState(T0), T0, new RetryableError('busy')).state;
    const sent = markSent(startDelivery(retried, at(1)), at(1), 'm-2');
    expect(sent.status).toBe('sent');
    expect(sent.attempts).toBe(1);
    expect(sent.lastError).toBeUndefined();
  });

  it('sweep counts a sending item older than 10 minutes as a failed attempt', () => {
    expect(SENDING_STALE_AFTER_MINUTES).toBe(10);
    const sending = startDelivery(newPendingState(T0), T0);
    // "More than 10 minutes" (architecture §5.4): exactly 10 is not stale yet.
    expect(isStale(sending, at(10))).toBe(false);
    expect(isStale(sending, new Date(at(10).getTime() + 1))).toBe(true);
    expect(() => sweepStale(sending, at(10))).toThrow(InvalidTransitionError);

    const { state, alertTherapist } = sweepStale(sending, at(11));
    expect(alertTherapist).toBe(false);
    expect(state).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAttemptAt: at(12).toISOString(),
    });
    expect(state.lastError).toEqual(expect.stringMatching(/./));
  });

  it('a sweep that reaches the attempt limit fails the item and alerts', () => {
    let state = newPendingState(T0);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      state = failOnce(state, new Date(state.nextAttemptAt), new RetryableError('busy')).state;
    }
    const started = new Date(state.nextAttemptAt);
    const stuck = startDelivery(state, started);
    const swept = sweepStale(
      stuck,
      new Date(started.getTime() + SENDING_STALE_AFTER_MINUTES * 60_000 + 1),
    );
    expect(swept.state.status).toBe('failed');
    expect(swept.alertTherapist).toBe(true);
  });

  it('manual retry (T9) resets a failed item to pending, due now, with a fresh attempt budget', () => {
    const failed = failOnce(newPendingState(T0), T0, new PermanentError('bad address')).state;
    const retried = resetForManualRetry(failed, at(60));
    expect(retried).toMatchObject({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: at(60).toISOString(),
      updatedAt: at(60).toISOString(),
      lastError: 'bad address',
    });
    expect(isDue(retried, at(60))).toBe(true);
  });

  it('a pending item that is not due yet cannot start delivery', () => {
    const notYetDue = failOnce(newPendingState(T0), T0, new RetryableError('busy')).state;
    expect(() => startDelivery(notYetDue, T0)).toThrow(InvalidTransitionError);
  });

  describe('refuses every transition the diagram does not allow, leaving the item unchanged', () => {
    const pending = Object.freeze(newPendingState(T0));
    const sending = Object.freeze(startDelivery(pending, T0));
    const sent = Object.freeze(markSent(sending, T0, 'm'));
    const failed = Object.freeze(failOnce(pending, T0, new PermanentError('no')).state);
    const states = { pending, sending, sent, failed } as const;

    // Every (status, action) cell outside the diagram's arrows; the allowed cells are
    // covered by the transition specs above.
    const actions = {
      deliver: (s: DeliveryState) => startDelivery(s, at(60)),
      'provider accepted': (s: DeliveryState) => markSent(s, at(60), 'late'),
      'provider accepted without an id': (s: DeliveryState) => markSent(s, at(60)),
      'provider accepted with a blank id': (s: DeliveryState) => markSent(s, at(60), '  '),
      'retryable error': (s: DeliveryState) =>
        markFailedAttempt(s, at(60), new RetryableError('x')),
      'permanent error': (s: DeliveryState) =>
        markFailedAttempt(s, at(60), new PermanentError('x')),
      sweep: (s: DeliveryState) => sweepStale(s, at(60)),
      'manual retry': (s: DeliveryState) => resetForManualRetry(s, at(60)),
    } as const;
    const forbidden: [keyof typeof states, keyof typeof actions][] = [
      ['pending', 'provider accepted'],
      ['pending', 'provider accepted without an id'],
      ['pending', 'provider accepted with a blank id'],
      ['pending', 'retryable error'],
      ['pending', 'permanent error'],
      ['pending', 'sweep'],
      ['pending', 'manual retry'],
      ['sending', 'deliver'],
      ['sending', 'manual retry'],
      ['sent', 'deliver'],
      ['sent', 'provider accepted'],
      ['sent', 'provider accepted without an id'],
      ['sent', 'provider accepted with a blank id'],
      ['sent', 'retryable error'],
      ['sent', 'permanent error'],
      ['sent', 'sweep'],
      ['sent', 'manual retry'],
      ['failed', 'deliver'],
      ['failed', 'provider accepted'],
      ['failed', 'provider accepted without an id'],
      ['failed', 'provider accepted with a blank id'],
      ['failed', 'retryable error'],
      ['failed', 'permanent error'],
      ['failed', 'sweep'],
    ];

    it.each(forbidden)('%s × %s', (status, action) => {
      const before = structuredClone(states[status]);
      expect(() => actions[action](states[status])).toThrow(InvalidTransitionError);
      expect(states[status]).toEqual(before);
    });
  });

  it('stored error text is capped so it fits the item and the dashboard', () => {
    expect(MAX_ERROR_LENGTH).toBe(500);
    const long = 'x'.repeat(MAX_ERROR_LENGTH + 100);
    expect(
      failOnce(newPendingState(T0), T0, new RetryableError(long)).state.lastError,
    ).toHaveLength(MAX_ERROR_LENGTH);
    expect(
      failOnce(newPendingState(T0), T0, new PermanentError(long)).state.lastError,
    ).toHaveLength(MAX_ERROR_LENGTH);
    expect(failOnce(newPendingState(T0), T0, new Error('short')).state.lastError).toBe('short');
  });

  // Value: protects=the cap never leaves half of a UTF-16 surrogate pair (an emoji) at the end; fails_when=the cap slices at a fixed index; why_new=the cap spec uses ASCII only; seam=none; no_claim=grapheme clusters
  it('the error cap does not split a character outside the basic plane', () => {
    const text = `${'x'.repeat(MAX_ERROR_LENGTH - 1)}😀tail`;
    const { lastError } = failOnce(newPendingState(T0), T0, new Error(text)).state;
    expect(lastError).toBe('x'.repeat(MAX_ERROR_LENGTH - 1));
    expect(lastError).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  // Value: protects=a stored error is never empty and reading the error never throws (empty message, non-string message, '' thrown, throwing message or name getter); fails_when=a fallback, the String() conversion or a try/catch in describeError/nameOf is dropped; why_new=only plain messages were covered; seam=none; no_claim=wording of the fallback
  it('records an error with an empty or unreadable message by its name, without throwing', () => {
    const empty = failOnce(newPendingState(T0), T0, new PermanentError('')).state;
    expect(empty.lastError).toBe('PermanentError');

    // SDK errors can carry a non-string message; it is stored as text, not a crash.
    const numeric = Object.assign(new PermanentError('x'), { message: 503 as unknown as string });
    expect(failOnce(newPendingState(T0), T0, numeric).state).toMatchObject({
      status: 'failed',
      lastError: '503',
    });

    const unreadable = new Error('x');
    Object.defineProperty(unreadable, 'message', {
      get() {
        throw new Error('boom');
      },
    });
    const { state } = failOnce(newPendingState(T0), T0, unreadable);
    expect(state).toMatchObject({ status: 'pending', attempts: 1 });
    expect(state.lastError).toEqual(expect.stringMatching(/./));
    expect(failOnce(newPendingState(T0), T0, Object.create(null)).state.lastError).toEqual(
      expect.stringMatching(/./),
    );
    expect(failOnce(newPendingState(T0), T0, '').state.lastError).toEqual(
      expect.stringMatching(/./),
    );

    const nameless = new Error('provider said no');
    Object.defineProperty(nameless, 'name', {
      get() {
        throw new Error('boom');
      },
    });
    expect(classifyError(nameless)).toBe('retryable');
    expect(failOnce(newPendingState(T0), T0, nameless).state).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'provider said no',
    });
  });

  // Value: protects=a PermanentError from a second copy of the module (two bundles) still fails the item; fails_when=classifyError relies on instanceof only; why_new=specs share one module instance; seam=none; no_claim=errors renamed by minifiers
  it('a permanent error from another copy of the module is still permanent', () => {
    class PermanentError extends Error {
      override name = 'PermanentError';
    }
    expect(classifyError(new PermanentError('bad address'))).toBe('permanent');
    expect(failOnce(newPendingState(T0), T0, new PermanentError('x')).state.status).toBe('failed');
  });

  // Value: protects=a corrupt stored attempt counter fails the item and alerts (keeping the provider's reason) instead of retrying forever or sticking in sending; fails_when=the arithmetic goes on, it throws, or the provider reason is dropped; why_new=attempts always came from newPendingState; seam=none; no_claim=wording of lastError
  it('a stored attempt counter that is not a whole number fails the item and alerts', () => {
    const sending = startDelivery(newPendingState(T0), T0);
    for (const attempts of [Number.NaN, -1, 1.5, '2', undefined]) {
      const corrupt = { ...sending, attempts } as unknown as DeliveryState;
      const outcome = markFailedAttempt(corrupt, T0, new RetryableError('x'));
      expect(outcome.state, String(attempts)).toMatchObject({
        status: 'failed',
        attempts: MAX_ATTEMPTS,
      });
      expect(outcome.alertTherapist, String(attempts)).toBe(true);
      // The sweep goes through the same path, so a stuck corrupt item fails too.
      const swept = sweepStale(corrupt, at(11));
      expect(swept.state, String(attempts)).toMatchObject({
        status: 'failed',
        attempts: MAX_ATTEMPTS,
      });
      expect(swept.alertTherapist, String(attempts)).toBe(true);
      // A corrupt item still in sending can neither start again nor be retried by hand.
      expect(() => startDelivery(corrupt, at(60))).toThrow(InvalidTransitionError);
      expect(() => resetForManualRetry(corrupt, at(60))).toThrow(InvalidTransitionError);
      // The provider accepting it still means sent.
      expect(markSent(corrupt, at(1), 'm-1')).toMatchObject({
        status: 'sent',
        providerMessageId: 'm-1',
        sentAt: at(1).toISOString(),
      });
      // The therapist's manual retry (T9) gives the failed item a fresh, valid counter, due now.
      const retried = resetForManualRetry(outcome.state, at(60));
      expect(retried).toMatchObject({
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at(60).toISOString(),
      });
      expect(isDue(retried, at(60))).toBe(true);
    }
    // A permanent error on a corrupt item keeps the provider's reason for the therapist.
    const corrupt = { ...sending, attempts: Number.NaN } as DeliveryState;
    const permanent = markFailedAttempt(corrupt, T0, new PermanentError('mailbox does not exist'));
    expect(permanent.state).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect(permanent.alertTherapist).toBe(true);
    expect(permanent.state.lastError).toContain('mailbox does not exist');
    const long = markFailedAttempt(corrupt, T0, new RetryableError('y'.repeat(MAX_ERROR_LENGTH)));
    expect(long.state.lastError).toHaveLength(MAX_ERROR_LENGTH);
  });

  // Value: protects=the back-off lookup refuses a count that is not a whole number from 1 instead of returning a zero delay; fails_when=the guard is dropped or the clamp changes; why_new=only reachable through valid counters in markFailedAttempt; seam=none; no_claim=none beyond protects
  it('back-off takes a whole number of failed attempts from 1 and stays at the last step', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => backoffMinutes(bad), String(bad)).toThrow(RangeError);
    }
    expect(backoffMinutes(1)).toBe(BACKOFF_MINUTES[0]);
    expect(backoffMinutes(MAX_ATTEMPTS + 3)).toBe(BACKOFF_MINUTES.at(-1));
  });

  // Value: protects=a failed or retried item never shows a send that did not happen (no provider id, no sent time), on both the normal and the corrupt-counter path; fails_when=markFailedAttempt or the sweep carries a stale id or sentAt; why_new=specs never seeded send fields on a sending item; seam=none; no_claim=how corrupt data got them
  it('only a successful send stores a provider id and a sent time', () => {
    const stale = {
      ...startDelivery(newPendingState(T0), T0),
      providerMessageId: 'old',
      sentAt: T0.toISOString(),
    };
    const corrupt = { ...stale, attempts: Number.NaN } as DeliveryState;
    for (const item of [stale, corrupt]) {
      for (const outcome of [
        markFailedAttempt(item, at(1), new RetryableError('x')),
        markFailedAttempt(item, at(1), new PermanentError('x')),
        sweepStale(item, at(11)),
      ]) {
        expect(outcome.state, String(item.attempts)).not.toHaveProperty('providerMessageId');
        expect(outcome.state, String(item.attempts)).not.toHaveProperty('sentAt');
      }
      expect(markSent(item, at(1), 'new')).toMatchObject({
        providerMessageId: 'new',
        sentAt: at(1).toISOString(),
      });
    }
  });

  // Value: protects=a message the provider accepted is recorded as sent even without an id, so the sweep never re-sends it, and no empty id is stored; fails_when=markSent throws or stores ''; why_new=specs always pass an id; seam=none; no_claim=id format per provider
  it('marks a notification sent without storing an empty provider message id', () => {
    const sending = startDelivery(newPendingState(T0), T0);
    const sent = markSent(sending, at(1), '');
    expect(sent).toMatchObject({ status: 'sent', sentAt: at(1).toISOString() });
    expect(sent).not.toHaveProperty('providerMessageId');
    expect(isStale(sent, at(60))).toBe(false);
    // A provider id left on the item by corrupt data is not carried into the sent state.
    const stale = { ...sending, providerMessageId: 'old' };
    expect(markSent(stale, at(1), '')).not.toHaveProperty('providerMessageId');
    // A missing or blank id identifies no send, so it is not stored either.
    expect(markSent(sending, at(1))).not.toHaveProperty('providerMessageId');
    expect(markSent(sending, at(1), '   ')).not.toHaveProperty('providerMessageId');
  });

  it('transitions never mutate their input', () => {
    const pending = Object.freeze(newPendingState(T0));
    const sending = Object.freeze(startDelivery(pending, T0));
    expect(() => markSent(sending, T0, 'm')).not.toThrow();
    expect(() => markFailedAttempt(sending, T0, new RetryableError('x'))).not.toThrow();
    expect(() => sweepStale(sending, at(11))).not.toThrow();
    const failed = Object.freeze(failOnce(pending, T0, new PermanentError('no')).state);
    expect(() => resetForManualRetry(failed, at(60))).not.toThrow();
    expect(pending.status).toBe('pending');
    expect(sending.status).toBe('sending');
    expect(failed.status).toBe('failed');
  });
});
