/**
 * Notification delivery state machine (docs/architecture.md §5.4, decision 12A). Pure functions:
 * each transition takes the current state and the instant, and returns a new state. The notifier
 * applies them with conditional writes, so a transition the diagram forbids throws here and the
 * matching conditional update fails there.
 *
 *   pending --deliver (due)--> sending --provider accepted (with or without an id)--> sent
 *   sending --retryable error, attempts < MAX_ATTEMPTS--> pending (nextAttemptAt = now + back-off)
 *   sending --permanent error, attempts reach MAX_ATTEMPTS, or a corrupt stored counter-->
 *       failed (alert the therapist)
 *   sending for more than SENDING_STALE_AFTER_MINUTES --sweep--> a retryable failed attempt
 *   failed --manual retry (T9)--> pending
 *
 * Instants are stored as UTC ISO strings, matching the persisted NOTIFICATION item.
 */
export type NotificationStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface DeliveryState {
  readonly status: NotificationStatus;
  /** Failed delivery attempts so far. */
  readonly attempts: number;
  /** Earliest instant a pending item may be delivered. */
  readonly nextAttemptAt: string;
  /** Instant of the last transition; the sweep measures a stuck `sending` from it. */
  readonly updatedAt: string;
  /** Provider error of the last failed attempt, at most {@link MAX_ERROR_LENGTH} UTF-16 units. */
  readonly lastError?: string;
  readonly providerMessageId?: string;
  readonly sentAt?: string;
}

/** The outcome of a failed attempt. `alertTherapist` is true when the item just became failed. */
export interface FailureOutcome {
  readonly state: DeliveryState;
  readonly alertTherapist: boolean;
}

export const MAX_ATTEMPTS = 5;
/** Wait after the 1st, 2nd, 3rd and 4th failed attempt; the 5th fails the item. */
export const BACKOFF_MINUTES: readonly number[] = [1, 5, 30, 120];
export const SENDING_STALE_AFTER_MINUTES = 10;
/**
 * Stored error text is capped: it lands in a DynamoDB item (400 KB limit) and on the therapist
 * dashboard. Full provider detail belongs in structured logs.
 */
export const MAX_ERROR_LENGTH = 500;

/** A transient provider failure (throttling, timeout, 5xx): try again later. */
export class RetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetryableError';
  }
}

/** A failure that retrying cannot fix (bad address, template error): fail now. */
export class PermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

export class InvalidTransitionError extends Error {
  constructor(transition: string, from: NotificationStatus, reason = '') {
    super(`Cannot ${transition} a notification in status ${from}${reason ? `: ${reason}` : ''}`);
    this.name = 'InvalidTransitionError';
  }
}

export type ErrorClass = 'retryable' | 'permanent';

/**
 * Only a {@link PermanentError} is permanent; anything unknown is retried. It is recognised by
 * name as well, so an error from a second copy of this module (two bundles) still counts.
 */
export function classifyError(error: unknown): ErrorClass {
  return error instanceof PermanentError || nameOf(error) === 'PermanentError'
    ? 'permanent'
    : 'retryable';
}

/** Minutes to wait after `attempts` failed attempts (a whole number from 1). */
export function backoffMinutes(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`Failed attempts must be a whole number from 1, got ${String(attempts)}`);
  }
  const index = Math.min(attempts, BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[index] ?? 0;
}

export function newPendingState(now: Date): DeliveryState {
  const iso = now.toISOString();
  return { status: 'pending', attempts: 0, nextAttemptAt: iso, updatedAt: iso };
}

export function isDue(state: DeliveryState, now: Date): boolean {
  return state.status === 'pending' && Date.parse(state.nextAttemptAt) <= now.getTime();
}

/** A `sending` item last touched more than {@link SENDING_STALE_AFTER_MINUTES} ago. */
export function isStale(state: DeliveryState, now: Date): boolean {
  return (
    state.status === 'sending' &&
    now.getTime() - Date.parse(state.updatedAt) > SENDING_STALE_AFTER_MINUTES * MINUTE_MS
  );
}

/** pending (due) → sending. */
export function startDelivery(state: DeliveryState, now: Date): DeliveryState {
  if (state.status !== 'pending')
    throw new InvalidTransitionError('start delivery of', state.status);
  if (!isDue(state, now)) {
    throw new InvalidTransitionError('start delivery of', state.status, 'not due yet');
  }
  return { ...state, status: 'sending', updatedAt: now.toISOString() };
}

/**
 * sending → sent. The provider has accepted the message, so the item is sent even when the
 * provider returned no id; a missing or blank id is not stored.
 */
export function markSent(
  state: DeliveryState,
  now: Date,
  providerMessageId?: string,
): DeliveryState {
  if (state.status !== 'sending') throw new InvalidTransitionError('mark sent', state.status);
  const { lastError: _dropped, providerMessageId: _previous, ...rest } = state;
  const iso = now.toISOString();
  return {
    ...rest,
    status: 'sent',
    ...(providerMessageId?.trim() ? { providerMessageId } : {}),
    sentAt: iso,
    updatedAt: iso,
  };
}

/**
 * sending → pending with back-off, or → failed (permanent error or attempt limit reached).
 * A stored attempt counter that is not a whole number cannot be trusted to stop the retries,
 * so the item fails and the therapist is alerted.
 */
export function markFailedAttempt(state: DeliveryState, now: Date, error: unknown): FailureOutcome {
  if (state.status !== 'sending') {
    throw new InvalidTransitionError('record a failed attempt of', state.status);
  }
  const iso = now.toISOString();
  if (!Number.isInteger(state.attempts) || state.attempts < 0) {
    const lastError = capErrorText(
      `stored attempts counter is not a whole number; ${describeError(error)}`,
    );
    return {
      state: { ...state, status: 'failed', attempts: MAX_ATTEMPTS, lastError, updatedAt: iso },
      alertTherapist: true,
    };
  }
  const attempts = state.attempts + 1;
  const lastError = capErrorText(describeError(error));
  if (classifyError(error) === 'permanent' || attempts >= MAX_ATTEMPTS) {
    return {
      state: { ...state, status: 'failed', attempts, lastError, updatedAt: iso },
      alertTherapist: true,
    };
  }
  const nextAttemptAt = new Date(
    now.getTime() + backoffMinutes(attempts) * MINUTE_MS,
  ).toISOString();
  return {
    state: { ...state, status: 'pending', attempts, lastError, nextAttemptAt, updatedAt: iso },
    alertTherapist: false,
  };
}

/** A stale `sending` item (the notifier died mid-send) counts as a retryable failed attempt. */
export function sweepStale(state: DeliveryState, now: Date): FailureOutcome {
  if (!isStale(state, now)) {
    throw new InvalidTransitionError(
      'sweep',
      state.status,
      `only sending items older than ${SENDING_STALE_AFTER_MINUTES} minutes`,
    );
  }
  return markFailedAttempt(
    state,
    now,
    new RetryableError(`delivery did not complete within ${SENDING_STALE_AFTER_MINUTES} minutes`),
  );
}

/** failed → pending, due now, with a fresh attempt budget (T9). The last error stays visible. */
export function resetForManualRetry(state: DeliveryState, now: Date): DeliveryState {
  if (state.status !== 'failed') throw new InvalidTransitionError('retry', state.status);
  const iso = now.toISOString();
  return { ...state, status: 'pending', attempts: 0, nextAttemptAt: iso, updatedAt: iso };
}

const MINUTE_MS = 60_000;

/** The error's message, else its name, else its string form; never throws. */
function describeError(error: unknown): string {
  try {
    if (error instanceof Error) return String(error.message || error.name || 'Error');
    return String(error) || 'unknown error';
  } catch {
    return 'unreadable error';
  }
}

/** At most {@link MAX_ERROR_LENGTH} UTF-16 units, without splitting a surrogate pair. */
function capErrorText(text: string): string {
  if (text.length <= MAX_ERROR_LENGTH) return text;
  const last = text.charCodeAt(MAX_ERROR_LENGTH - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? MAX_ERROR_LENGTH - 1 : MAX_ERROR_LENGTH);
}

function nameOf(error: unknown): unknown {
  try {
    return typeof error === 'object' && error !== null
      ? (error as { name?: unknown }).name
      : undefined;
  } catch {
    return undefined;
  }
}
