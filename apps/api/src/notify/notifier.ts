import { renderTemplate, type TenantId, TenantIdSchema } from '@fisio/contracts';
import {
  type AsyncHandler,
  type ChannelName,
  type Clock,
  type DeliveryState,
  errorName,
  isDue,
  isStale,
  markFailedAttempt,
  markSent,
  type NotificationChannel,
  PermanentError,
  SENDING_STALE_AFTER_MINUTES,
  startDelivery,
  sweepStale,
} from '@fisio/domain';
import { z } from 'zod';
import { notificationMonthOf, previousNotificationMonth } from '../repo/keys';
import {
  CorruptNotificationError,
  type NotificationRef,
  NotificationRefSchema,
  type NotificationRepository,
  type NotificationScan,
  type StoredNotification,
} from '../repo/notifications';

/**
 * The notifier (docs/architecture.md §4.3, §5.4): delivers NOTIFICATION items through the channel
 * adapters, applying the delivery state machine of `@fisio/domain` with conditional writes. It is
 * started three ways, each an event of {@link NotifierEventSchema}:
 *
 * - `deliver`: the ids a use case just committed, sent by the API's async invoke (immediate path);
 * - `deliver-due` and `sweep`: sent by the jobs tick every 15 minutes (eventual path, retries).
 *
 * Every write is conditional on the state it read (status and `updatedAt`), so duplicate or
 * concurrent invocations deliver an item once, and a late result never overwrites a newer attempt.
 * SNS records (SES bounces and complaints) reach the `ses-feedback` entry point, a stub until WP2.5.
 */
export type NotifierLog = (event: string, details: Readonly<Record<string, unknown>>) => void;

export const consoleNotifierLog: NotifierLog = (event, details) => {
  console.error(`[notifier] ${event}`, details);
};

export interface NotifierDeps {
  readonly notifications: NotificationRepository;
  readonly channels: Readonly<Partial<Record<ChannelName, NotificationChannel>>>;
  readonly clock: Clock;
  readonly log: NotifierLog;
}

/** What happened to each item a run looked at. */
export interface DeliveryReport {
  readonly sent: readonly NotificationRef[];
  /** Failed attempts that went back to `pending` with a back-off. */
  readonly retrying: readonly NotificationRef[];
  /** Items that became `failed` (permanent error, attempt limit, corrupt counter). */
  readonly failed: readonly NotificationRef[];
  /** Not due, already taken by another run, or gone. */
  readonly skipped: readonly NotificationRef[];
}

type Outcome = keyof DeliveryReport;

export class Notifier {
  constructor(private readonly deps: NotifierDeps) {}

  /** Delivers the given items now if they are due (`deliver` events). */
  async deliver(tenantId: TenantId, refs: readonly NotificationRef[]): Promise<DeliveryReport> {
    return this.#run(
      refs,
      (ref) => ref,
      async (ref) => {
        let item: StoredNotification | undefined;
        try {
          item = await this.deps.notifications.get(tenantId, ref);
        } catch (error) {
          // As in deliver-due: retrying cannot repair it, so it must not fail the invocation.
          if (!(error instanceof CorruptNotificationError)) throw error;
          this.#logCorrupt(tenantId, error);
          return 'skipped';
        }
        return item ? this.#deliverOne(tenantId, item) : 'skipped';
      },
    );
  }

  /** Delivers every `pending` item whose back-off has elapsed, this month and last (§6.3). */
  async deliverDue(tenantId: TenantId): Promise<DeliveryReport> {
    const now = this.deps.clock.now();
    const scan = await this.deps.notifications.findDue(tenantId, monthsAround(now), now);
    return this.#runScan(tenantId, scan, (item) => this.#deliverOne(tenantId, item));
  }

  /**
   * Recovers items left in `sending` for more than {@link SENDING_STALE_AFTER_MINUTES} minutes (a
   * notifier that died mid-send): each counts as a failed attempt, back to `pending` with a
   * back-off, or `failed` at the attempt limit.
   */
  async sweep(tenantId: TenantId): Promise<DeliveryReport> {
    const now = this.deps.clock.now();
    const staleBefore = new Date(now.getTime() - SENDING_STALE_AFTER_MINUTES * 60_000);
    const scan = await this.deps.notifications.findSendingSince(
      tenantId,
      monthsAround(now),
      staleBefore,
    );
    return this.#runScan(tenantId, scan, async (item) => {
      // The query and this clock reading may disagree at the boundary: re-check, never throw.
      const at = this.deps.clock.now();
      if (!isStale(item.state, at)) return 'skipped';
      const outcome = sweepStale(item.state, at);
      if (
        !(await this.deps.notifications.transition(tenantId, item.ref, item.state, outcome.state))
      ) {
        return 'skipped';
      }
      this.deps.log('notification_swept', {
        tenantId,
        ref: item.ref,
        status: outcome.state.status,
      });
      if (outcome.alertTherapist) this.#alert(tenantId, item, outcome.state.lastError);
      return outcome.state.status === 'failed' ? 'failed' : 'retrying';
    });
  }

  async #deliverOne(tenantId: TenantId, item: StoredNotification): Promise<Outcome> {
    const { notifications, clock, log } = this.deps;
    const startedAt = clock.now();
    if (!isDue(item.state, startedAt)) return 'skipped';
    const sending = startDelivery(item.state, startedAt);
    if (!(await notifications.transition(tenantId, item.ref, item.state, sending))) {
      return 'skipped';
    }

    let providerMessageId: unknown;
    try {
      const channel = this.deps.channels[item.channel];
      if (!channel) throw new PermanentError(`no ${item.channel} channel is configured`);
      const email = renderTemplate(item.template, item.params);
      ({ providerMessageId } = await channel.send({
        channel: item.channel,
        notificationKey: item.ref.key,
        to: item.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
      }));
    } catch (error) {
      const outcome = markFailedAttempt(sending, clock.now(), error);
      log('notification_attempt_failed', {
        tenantId,
        ref: item.ref,
        status: outcome.state.status,
        attempts: outcome.state.attempts,
        error: describeError(error),
      });
      if (!(await notifications.transition(tenantId, item.ref, sending, outcome.state))) {
        log('notification_outcome_lost', { tenantId, ref: item.ref, outcome: 'failed attempt' });
        return 'skipped';
      }
      if (outcome.alertTherapist) this.#alert(tenantId, item, outcome.state.lastError);
      return outcome.state.status === 'failed' ? 'failed' : 'retrying';
    }

    const sent = markSent(sending, clock.now(), providerMessageId);
    if (!(await this.#recordSent(tenantId, item.ref, sending, sent))) {
      // The sweep took the item back meanwhile, or DynamoDB kept failing: the message is out, and
      // the sweep may send it once more.
      log('notification_outcome_lost', { tenantId, ref: item.ref, outcome: 'sent' });
    }
    return 'sent';
  }

  /**
   * The `sending → sent` write. The provider has accepted the message, so a failed write is
   * retried here and never thrown: a thrown error would leave the item in `sending` for the sweep
   * to send again, while the invocation's own retries skip it. False when it could not be written.
   */
  async #recordSent(
    tenantId: TenantId,
    ref: NotificationRef,
    sending: DeliveryState,
    sent: DeliveryState,
  ): Promise<boolean> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.deps.notifications.transition(tenantId, ref, sending, sent);
      } catch (error) {
        this.deps.log('notification_sent_write_failed', {
          tenantId,
          ref,
          attempt,
          error: describeError(error),
        });
        if (attempt >= SENT_WRITE_ATTEMPTS) return false;
        await new Promise((resolve) => setTimeout(resolve, SENT_WRITE_BACKOFF_MS * attempt));
      }
    }
  }

  #logCorrupt(tenantId: TenantId, corrupt: CorruptNotificationError): void {
    this.deps.log('notification_corrupt', {
      tenantId,
      ref: corrupt.ref,
      error: describeError(corrupt),
    });
  }

  /**
   * A notification just became `failed`. The structured log line feeds the failed-notifications
   * alarm (WP2.7); the therapist's `FAIL` email and the dashboard entry arrive with WP2.5.
   */
  #alert(tenantId: TenantId, item: StoredNotification, lastError: string | undefined): void {
    this.deps.log('notification_failed', { tenantId, ref: item.ref, kind: item.kind, lastError });
  }

  async #runScan(
    tenantId: TenantId,
    scan: NotificationScan,
    one: (item: StoredNotification) => Promise<Outcome>,
  ): Promise<DeliveryReport> {
    for (const corrupt of scan.corrupt) this.#logCorrupt(tenantId, corrupt);
    return this.#run(scan.items, (item) => item.ref, one);
  }

  /** Runs each item on its own: one failing item is logged and does not stop the others. */
  async #run<T>(
    items: readonly T[],
    refOf: (item: T) => NotificationRef,
    one: (item: T) => Promise<Outcome>,
  ): Promise<DeliveryReport> {
    const report: Record<Outcome, NotificationRef[]> = {
      sent: [],
      retrying: [],
      failed: [],
      skipped: [],
    };
    const errors: unknown[] = [];
    for (const item of items) {
      const ref = refOf(item);
      try {
        report[await one(item)].push(ref);
      } catch (error) {
        errors.push(error);
        this.deps.log('notification_delivery_error', { ref, error: describeError(error) });
      }
    }
    // Rethrown after the loop, so the invocation is reported as failed (async invoke retries
    // it, the alarm counts it) without starving the items after the broken one.
    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} notification(s) could not be processed`);
    }
    return report;
  }
}

/** How often the `sent` write is tried after the provider accepted, and the back-off step. */
const SENT_WRITE_ATTEMPTS = 3;
const SENT_WRITE_BACKOFF_MS = 100;

/**
 * An error as a log line shows it: its name and message, never the error itself, whose `cause`
 * (the provider's error) can carry the recipient address or stored values.
 */
export function describeError(error: unknown): { name: string; message: string } {
  return {
    name: errorName(error) ?? 'unknown',
    message: error instanceof Error ? error.message : 'not an Error',
  };
}

/** The current UTC month and the one before: where pending and stuck items can be (§6.3). */
function monthsAround(now: Date) {
  const month = notificationMonthOf(now);
  return [month, previousNotificationMonth(month)];
}

const DeliverEventSchema = z.object({
  kind: z.literal('deliver'),
  tenantId: TenantIdSchema,
  notifications: z.array(NotificationRefSchema).min(1).max(100),
});

/** The events the notifier accepts from the API and the jobs tick. */
export const NotifierEventSchema = z.discriminatedUnion('kind', [
  DeliverEventSchema,
  z.object({ kind: z.literal('deliver-due'), tenantId: TenantIdSchema }),
  z.object({ kind: z.literal('sweep'), tenantId: TenantIdSchema }),
]);
export type NotifierEvent = z.input<typeof NotifierEventSchema>;

/** The event that delivers what a use case just committed. */
export function deliverEvent(tenantId: TenantId, refs: readonly NotificationRef[]): NotifierEvent {
  return { kind: 'deliver', tenantId, notifications: [...refs] };
}

/** An SNS delivery to the notifier: SES bounce and complaint feedback (§5.4). */
const SnsEventSchema = z.object({
  Records: z
    .array(z.object({ EventSource: z.literal('aws:sns'), Sns: z.object({ Message: z.string() }) }))
    .min(1),
});

/**
 * The notifier's entry point, for the Lambda handler and the in-process `AsyncInvoker`. An event
 * it does not recognise throws, so the invocation is reported as failed.
 */
export function createNotifierHandler(notifier: Notifier, log: NotifierLog): AsyncHandler {
  return async (event) => {
    const sns = SnsEventSchema.safeParse(event);
    if (sns.success) {
      sesFeedback(
        sns.data.Records.map((record) => record.Sns.Message),
        log,
      );
      return;
    }
    const parsed = NotifierEventSchema.parse(event);
    switch (parsed.kind) {
      case 'deliver':
        await notifier.deliver(parsed.tenantId, parsed.notifications);
        return;
      case 'deliver-due':
        await notifier.deliverDue(parsed.tenantId);
        return;
      case 'sweep':
        await notifier.sweep(parsed.tenantId);
        return;
    }
  };
}

/**
 * The `ses-feedback` entry point, a stub until WP2.5 (bounced or complained client, `FAIL`
 * notification, dashboard): it records which kind of feedback arrived, nothing of its content.
 */
function sesFeedback(messages: readonly string[], log: NotifierLog): void {
  for (const message of messages) {
    let type: unknown;
    try {
      // SES notifications carry `notificationType`, configuration-set event publishing `eventType`.
      const parsed = JSON.parse(message) as { notificationType?: unknown; eventType?: unknown };
      type = parsed.notificationType ?? parsed.eventType;
    } catch {
      type = 'unparsable';
    }
    log('ses_feedback_ignored', { type: typeof type === 'string' ? type : 'unknown' });
  }
}
