import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  BookingIdSchema,
  ClientIdSchema,
  IsoDateTimeSchema,
  type TenantId,
} from '@fisio/contracts';
import {
  type ChannelName,
  type DeliveryState,
  isErrorNamed,
  type NotificationStatus,
  newPendingState,
} from '@fisio/domain';
import { z } from 'zod';
import {
  isNotificationKey,
  isNotificationMonth,
  type NotificationKey,
  type NotificationMonth,
  notificationMonthOf,
  notificationPk,
} from './keys';

/**
 * NOTIFICATION items (docs/architecture.md §5.4, §6.2): the transactional outbox. A use case adds
 * {@link NotificationRepository.newItem} to its own transaction, so a notification exists exactly
 * when the business change does; the notifier then moves it through the delivery state machine
 * (`@fisio/domain` notification-state) with {@link NotificationRepository.transition}.
 */
export const NOTIFICATION_KINDS = [
  'invitation',
  'confirmation',
  'cancellation',
  'reminder',
  'digest',
  'failure',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Where an item lives: the month partition it was created in, and its deterministic key. */
export interface NotificationRef {
  readonly month: NotificationMonth;
  readonly key: NotificationKey;
}

/** A {@link NotificationRef} read from an event or another untrusted source. */
export const NotificationRefSchema = z.object({
  month: z
    .string()
    .refine(isNotificationMonth)
    .transform((m) => m as NotificationMonth),
  key: z
    .string()
    .max(200)
    .refine(isNotificationKey)
    .transform((k) => k as NotificationKey),
});

const STATUSES = ['pending', 'sending', 'sent', 'failed'] as const satisfies NotificationStatus[];

/**
 * The stored item. `attempts` is any number on purpose: the state machine fails an item whose
 * counter is not a whole number (and alerts), which a stricter schema would hide as corrupt.
 */
const NotificationItemSchema = z.object({
  kind: z.enum(NOTIFICATION_KINDS),
  template: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  channel: z.literal('email'),
  to: z.string().min(1),
  clientId: ClientIdSchema.optional(),
  bookingId: BookingIdSchema.optional(),
  status: z.enum(STATUSES),
  attempts: z.number(),
  nextAttemptAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  lastError: z.string().optional(),
  providerMessageId: z.string().optional(),
  sentAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
});

export interface StoredNotification {
  readonly ref: NotificationRef;
  readonly kind: NotificationKind;
  readonly template: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly channel: ChannelName;
  readonly to: string;
  readonly clientId?: string;
  readonly bookingId?: string;
  readonly createdAt: string;
  readonly state: DeliveryState;
}

export interface NewNotification {
  readonly key: NotificationKey;
  readonly kind: NotificationKind;
  readonly template: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly channel: ChannelName;
  readonly to: string;
  readonly clientId?: string;
  readonly bookingId?: string;
}

/** A `TransactWriteItems` entry, as `@aws-sdk/lib-dynamodb` takes it. */
export interface TransactPut {
  readonly Put: {
    readonly TableName: string;
    readonly Item: Record<string, unknown>;
    readonly ConditionExpression: string;
  };
}

/** A stored item that no longer matches the schema: logged and skipped, never delivered. */
export class CorruptNotificationError extends Error {
  override readonly name = 'CorruptNotificationError';
  constructor(
    readonly ref: NotificationRef,
    options?: ErrorOptions,
  ) {
    super(`Notification ${ref.month}/${ref.key} does not match its schema`, options);
  }
}

export interface NotificationScan {
  readonly items: readonly StoredNotification[];
  readonly corrupt: readonly CorruptNotificationError[];
}

/** Kept 180 days (§6.2), then removed by DynamoDB's TTL. */
export const NOTIFICATION_TTL_DAYS = 180;

/** Attributes a transition may drop; one absent from the new state is removed from the item. */
const OPTIONAL_STATE_FIELDS = ['lastError', 'providerMessageId', 'sentAt'] as const;

export class NotificationRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  /**
   * The outbox item for a use case's transaction: `pending`, due now, written only if its key is
   * free in the month partition of `now`, so a rerun of the same business change in the same UTC
   * month adds nothing (a rerun in a later month would write a second item).
   */
  newItem(
    tenantId: TenantId,
    notification: NewNotification,
    now: Date,
  ): { ref: NotificationRef; put: TransactPut } {
    const ref: NotificationRef = { month: notificationMonthOf(now), key: notification.key };
    const item = NotificationItemSchema.parse({
      kind: notification.kind,
      template: notification.template,
      params: notification.params,
      channel: notification.channel,
      to: notification.to,
      ...(notification.clientId ? { clientId: notification.clientId } : {}),
      ...(notification.bookingId ? { bookingId: notification.bookingId } : {}),
      ...newPendingState(now),
      createdAt: now.toISOString(),
    });
    return {
      ref,
      put: {
        Put: {
          TableName: this.table,
          Item: {
            PK: notificationPk(tenantId, ref.month),
            SK: ref.key,
            entity: 'NOTIFICATION',
            ...item,
            ttl: Math.floor(now.getTime() / 1000) + NOTIFICATION_TTL_DAYS * 86_400,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    };
  }

  /** The item, read strongly consistent; throws {@link CorruptNotificationError} for a bad one. */
  async get(tenantId: TenantId, ref: NotificationRef): Promise<StoredNotification | undefined> {
    const { Item } = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: notificationPk(tenantId, ref.month), SK: ref.key },
        ConsistentRead: true,
      }),
    );
    if (!Item) return undefined;
    const parsed = toStored(ref, Item);
    if (parsed instanceof CorruptNotificationError) throw parsed;
    return parsed;
  }

  /**
   * Applies one state-machine transition, only if the item is still in `from`: same status and
   * same `updatedAt`, so two notifiers racing for a pending item have one winner, and a notifier
   * whose `sending` item was swept and restarted cannot overwrite the newer attempt with its late
   * result. Attributes the new state no longer has are removed. False when the item moved on.
   */
  async transition(
    tenantId: TenantId,
    ref: NotificationRef,
    from: DeliveryState,
    to: DeliveryState,
  ): Promise<boolean> {
    const values: Record<string, unknown> = {
      ':status': to.status,
      ':attempts': to.attempts,
      ':nextAttemptAt': to.nextAttemptAt,
      ':updatedAt': to.updatedAt,
      ':fromStatus': from.status,
      ':fromUpdatedAt': from.updatedAt,
    };
    const set = [
      '#status = :status',
      'attempts = :attempts',
      'nextAttemptAt = :nextAttemptAt',
      'updatedAt = :updatedAt',
    ];
    const remove: string[] = [];
    for (const field of OPTIONAL_STATE_FIELDS) {
      const value = to[field];
      if (value === undefined) {
        remove.push(field);
      } else {
        set.push(`${field} = :${field}`);
        values[`:${field}`] = value;
      }
    }
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: notificationPk(tenantId, ref.month), SK: ref.key },
          UpdateExpression: `SET ${set.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''}`,
          ConditionExpression:
            'attribute_exists(PK) AND #status = :fromStatus AND updatedAt = :fromUpdatedAt',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: values,
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return true;
    } catch (error) {
      if (isErrorNamed(error, 'ConditionalCheckFailedException')) return wroteEarlier(error, to);
      throw error;
    }
  }

  /** `pending` items whose `nextAttemptAt` has come, in the given months (§6.3, pattern 9). */
  async findDue(
    tenantId: TenantId,
    months: readonly NotificationMonth[],
    now: Date,
  ): Promise<NotificationScan> {
    return this.#scan(tenantId, months, 'nextAttemptAt <= :instant', 'pending', now);
  }

  /** `sending` items last touched before `staleBefore`, in the given months (§6.3, pattern 9). */
  async findSendingSince(
    tenantId: TenantId,
    months: readonly NotificationMonth[],
    staleBefore: Date,
  ): Promise<NotificationScan> {
    return this.#scan(tenantId, months, 'updatedAt < :instant', 'sending', staleBefore);
  }

  async #scan(
    tenantId: TenantId,
    months: readonly NotificationMonth[],
    condition: string,
    status: NotificationStatus,
    instant: Date,
  ): Promise<NotificationScan> {
    const items: StoredNotification[] = [];
    const corrupt: CorruptNotificationError[] = [];
    for (const month of new Set(months)) {
      let cursor: Record<string, unknown> | undefined;
      do {
        const page = await this.doc.send(
          new QueryCommand({
            TableName: this.table,
            KeyConditionExpression: 'PK = :pk',
            FilterExpression: `#status = :status AND ${condition}`,
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':pk': notificationPk(tenantId, month),
              ':status': status,
              ':instant': instant.toISOString(),
            },
            ConsistentRead: true,
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }),
        );
        for (const item of page.Items ?? []) {
          const key = String(item.SK);
          if (!isNotificationKey(key)) {
            corrupt.push(new CorruptNotificationError({ month, key: key as NotificationKey }));
            continue;
          }
          const parsed = toStored({ month, key }, item);
          if (parsed instanceof CorruptNotificationError) corrupt.push(parsed);
          else items.push(parsed);
        }
        cursor = page.LastEvaluatedKey;
      } while (cursor);
    }
    return { items, corrupt };
  }
}

/**
 * A refused transition the SDK had retried: if an earlier attempt committed and only its answer
 * was lost (a timeout), the retry finds the item already in `to`, and the write was this call's.
 * A refusal on the first attempt is always another writer's, whatever the item holds.
 */
function wroteEarlier(error: unknown, to: DeliveryState): boolean {
  const failure = error as { $metadata?: { attempts?: number }; Item?: Record<string, unknown> };
  if ((failure.$metadata?.attempts ?? 1) < 2 || !failure.Item) return false;
  // The SDK leaves the returned item in DynamoDB's attribute-value form ({ S: '…' }).
  const text = (value: unknown) =>
    typeof value === 'object' && value !== null ? (value as { S?: unknown }).S : value;
  return text(failure.Item.status) === to.status && text(failure.Item.updatedAt) === to.updatedAt;
}

function toStored(
  ref: NotificationRef,
  item: Record<string, unknown>,
): StoredNotification | CorruptNotificationError {
  const parsed = NotificationItemSchema.safeParse(item);
  if (!parsed.success) return new CorruptNotificationError(ref, { cause: parsed.error });
  const n = parsed.data;
  return {
    ref,
    kind: n.kind,
    template: n.template,
    params: n.params,
    channel: n.channel,
    to: n.to,
    ...(n.clientId ? { clientId: n.clientId } : {}),
    ...(n.bookingId ? { bookingId: n.bookingId } : {}),
    createdAt: n.createdAt,
    state: {
      status: n.status,
      attempts: n.attempts,
      nextAttemptAt: n.nextAttemptAt,
      updatedAt: n.updatedAt,
      ...(n.lastError !== undefined ? { lastError: n.lastError } : {}),
      ...(n.providerMessageId !== undefined ? { providerMessageId: n.providerMessageId } : {}),
      ...(n.sentAt !== undefined ? { sentAt: n.sentAt } : {}),
    },
  };
}
