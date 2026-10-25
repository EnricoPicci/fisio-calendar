import type { BookingId, ClientId, TenantId } from '@fisio/contracts';
import { type ChannelName, isIsoDate } from '@fisio/domain';

/**
 * DynamoDB key values (docs/architecture.md §6.2). This folder is the only place that builds
 * them (CLAUDE.md convention 3), always from typed domain ids, never from raw request strings.
 */
export function tenantPk(tenantId: TenantId): string {
  return `T#${tenantId}`;
}

export function clientSk(clientId: ClientId): string {
  return `CLIENT#${clientId}`;
}

export const SETTINGS_SK = 'SETTINGS';

/** GSI2: clients by email, for the uniqueness check on add and the lookup by email. */
export function clientEmailGsi2(email: string): { GSI2PK: string; GSI2SK: string } {
  return { GSI2PK: `EMAIL#${email}`, GSI2SK: 'CLIENT' };
}

/** A UTC month, `yyyy-mm`: the notification partition an item was created in (§6.3, pattern 8). */
export type NotificationMonth = string & { readonly __notificationMonth: true };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isNotificationMonth(value: string): value is NotificationMonth {
  return MONTH.test(value);
}

/** The UTC month of an instant. */
export function notificationMonthOf(instant: Date): NotificationMonth {
  return instant.toISOString().slice(0, 7) as NotificationMonth;
}

/** The UTC month before `month`. */
export function previousNotificationMonth(month: NotificationMonth): NotificationMonth {
  const [year = 0, mm = 1] = month.split('-').map(Number);
  return notificationMonthOf(new Date(Date.UTC(year, mm - 2, 1)));
}

export function notificationPk(tenantId: TenantId, month: NotificationMonth): string {
  return `${tenantPk(tenantId)}#N#${month}`;
}

/**
 * The deterministic sort key of a NOTIFICATION item (§5.4, §6.2): one business event, one
 * channel, one key, so writing the same notification twice is a conditional-put no-op.
 */
export type NotificationKey = string & { readonly __notificationKey: true };

/** Any key built below: a family prefix, then ids, dates, channels and attempt numbers. */
const NOTIFICATION_KEY = /^(INVITE|CONF|CANC|REM|DIGEST|FAIL)(#[A-Za-z0-9:.-]{1,64}){1,3}$/;

/** True for a string shaped like a key built by {@link NotificationKeys}, e.g. read from an event. */
export function isNotificationKey(value: string): value is NotificationKey {
  return NOTIFICATION_KEY.test(value);
}

function key(...parts: (string | number)[]): NotificationKey {
  const built = parts.join('#');
  if (!isNotificationKey(built)) throw new RangeError(`Invalid notification key parts: ${built}`);
  return built as NotificationKey;
}

function localDate(date: string): string {
  if (!isIsoDate(date)) throw new RangeError(`Invalid local date "${date}"`);
  return date;
}

/**
 * The keys of §6.2. WP0.6 writes invitations; confirmations and cancellations come with the
 * booking transactions (WP1.3, WP2.2), reminders and the digest with the jobs (WP2.3, WP2.4),
 * failure alerts with SES feedback (WP2.5).
 */
export const NotificationKeys = {
  /** `attempt` counts invitations sent to the client: 1 on add, +1 per resend (WP1.5). */
  invitation(clientId: ClientId, attempt: number): NotificationKey {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new RangeError(`Invitation attempt must be a whole number from 1, got ${attempt}`);
    }
    return key('INVITE', clientId, attempt);
  },
  confirmation(bookingId: BookingId, channel: ChannelName): NotificationKey {
    return key('CONF', bookingId, channel);
  },
  cancellation(bookingId: BookingId, channel: ChannelName): NotificationKey {
    return key('CANC', bookingId, channel);
  },
  /** `date` is the local date of the reminder run, the day before the slot. */
  reminder(bookingId: BookingId, channel: ChannelName, date: string): NotificationKey {
    return key('REM', bookingId, channel, localDate(date));
  },
  digest(date: string): NotificationKey {
    return key('DIGEST', localDate(date), 'email');
  },
  failure(clientId: ClientId, date: string): NotificationKey {
    return key('FAIL', clientId, localDate(date));
  },
} as const;

/** The scheduler's jobs (§5.3) that run once per local day and leave a marker. */
export const JOB_NAMES = ['reminders', 'digest', 'extend-horizon'] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** `JOB#<name>#<date>` under the tenant: the job ran for that local date (§5.3, §6.2). */
export function jobMarkerSk(name: JobName, date: string): string {
  return `JOB#${name}#${localDate(date)}`;
}
