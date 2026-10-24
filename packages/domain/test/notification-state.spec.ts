import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MINUTES,
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

  it('sweep resets a sending item older than 10 minutes to pending as a failed attempt', () => {
    expect(SENDING_STALE_AFTER_MINUTES).toBe(10);
    const sending = startDelivery(newPendingState(T0), T0);
    expect(isStale(sending, at(9.99))).toBe(false);
    expect(isStale(sending, at(10))).toBe(true);
    expect(() => sweepStale(sending, at(9))).toThrow(InvalidTransitionError);

    const { state, alertTherapist } = sweepStale(sending, at(10));
    expect(alertTherapist).toBe(false);
    expect(state).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAttemptAt: at(11).toISOString(),
    });
    expect(state.lastError).toMatch(/10 minutes/);
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
      new Date(started.getTime() + SENDING_STALE_AFTER_MINUTES * 60_000),
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
      'retryable error': (s: DeliveryState) =>
        markFailedAttempt(s, at(60), new RetryableError('x')),
      'permanent error': (s: DeliveryState) =>
        markFailedAttempt(s, at(60), new PermanentError('x')),
      sweep: (s: DeliveryState) => sweepStale(s, at(60)),
      'manual retry': (s: DeliveryState) => resetForManualRetry(s, at(60)),
    } as const;
    const forbidden: [keyof typeof states, keyof typeof actions][] = [
      ['pending', 'provider accepted'],
      ['pending', 'retryable error'],
      ['pending', 'permanent error'],
      ['pending', 'sweep'],
      ['pending', 'manual retry'],
      ['sending', 'deliver'],
      ['sending', 'manual retry'],
      ['sent', 'deliver'],
      ['sent', 'provider accepted'],
      ['sent', 'retryable error'],
      ['sent', 'permanent error'],
      ['sent', 'sweep'],
      ['sent', 'manual retry'],
      ['failed', 'deliver'],
      ['failed', 'provider accepted'],
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

  it('transitions never mutate their input', () => {
    const pending = Object.freeze(newPendingState(T0));
    const sending = Object.freeze(startDelivery(pending, T0));
    expect(() => markSent(sending, T0, 'm')).not.toThrow();
    expect(() => markFailedAttempt(sending, T0, new RetryableError('x'))).not.toThrow();
    expect(pending.status).toBe('pending');
    expect(sending.status).toBe('sending');
  });
});
