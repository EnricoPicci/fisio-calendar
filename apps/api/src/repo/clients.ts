import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { ClientId } from '@fisio/contracts';
import {
  ClientIdSchema,
  ClientStatusSchema,
  EmailSchema,
  IsoDateTimeSchema,
  LocaleSchema,
  PhoneE164Schema,
  type TenantId,
} from '@fisio/contracts';
import { isErrorNamed } from '@fisio/domain';
import { z } from 'zod';
import { clientEmailGsi2, clientSk, tenantPk } from './keys';
import type { TransactPut } from './notifications';

/**
 * The client item (§6.2). `channels` and `emailStatus` default for items written before WP0.6;
 * consentAt and lastSignInAt arrive with WP1.5 and WP3.1.
 */
export const ClientRecordSchema = z.object({
  clientId: ClientIdSchema,
  name: z.string().min(1),
  email: EmailSchema,
  phone: PhoneE164Schema.optional(),
  status: ClientStatusSchema,
  locale: LocaleSchema,
  /** One outbox item per enabled channel (§3.4); WhatsApp is a later option (§12.1). */
  channels: z
    .object({ email: z.boolean(), whatsapp: z.boolean() })
    .default({ email: true, whatsapp: false }),
  emailStatus: z.enum(['ok', 'bounced', 'complained']).default('ok'),
  invitedAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
});
export type ClientRecord = z.infer<typeof ClientRecordSchema>;
/** A client item to write; the defaulted fields may be left out. */
export type ClientRecordInput = z.input<typeof ClientRecordSchema>;

/** `create` found a client item with this id already. */
export class ClientItemExistsError extends Error {
  override readonly name = 'ClientItemExistsError';
}

/** `create` collided with another transaction writing the same client at the same moment. */
export class ClientItemBusyError extends Error {
  override readonly name = 'ClientItemBusyError';
}

export class ClientRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  /**
   * The client, read strongly consistent: the per-request status check (§8.2) must see a block
   * or an erasure written a moment ago. A stored item that no longer matches the schema throws.
   */
  async get(tenantId: TenantId, clientId: ClientId): Promise<ClientRecord | undefined> {
    const { Item } = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: tenantPk(tenantId), SK: clientSk(clientId) },
        ConsistentRead: true,
      }),
    );
    return Item ? ClientRecordSchema.parse(Item) : undefined;
  }

  /** Writes the whole client item, whether or not it exists (the seed, specs, later edits). */
  async put(tenantId: TenantId, client: ClientRecordInput): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: this.#item(tenantId, client) }),
    );
  }

  /**
   * Creates the client item together with its outbox items in one transaction (§4.4 step 5):
   * all or nothing. Throws {@link ClientItemExistsError} when the client exists and
   * {@link ClientItemBusyError} when another transaction on its items was running (DynamoDB's
   * `TransactionConflict`); an outbox key that is taken fails the transaction like any other error.
   */
  async create(
    tenantId: TenantId,
    client: ClientRecordInput,
    outbox: readonly TransactPut[],
  ): Promise<ClientRecord> {
    const item = this.#item(tenantId, client);
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: item,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            ...outbox,
          ],
        }),
      );
    } catch (error) {
      const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
      if (isErrorNamed(error, 'TransactionCanceledException')) {
        if (reasons?.[0]?.Code === 'ConditionalCheckFailed') {
          throw new ClientItemExistsError('A client item with this id exists', { cause: error });
        }
        if (reasons?.some((reason) => reason.Code === 'TransactionConflict')) {
          throw new ClientItemBusyError('Another write of this client is running', {
            cause: error,
          });
        }
      }
      throw error;
    }
    return ClientRecordSchema.parse(item);
  }

  #item(tenantId: TenantId, client: ClientRecordInput): Record<string, unknown> {
    const record = ClientRecordSchema.parse(client);
    return {
      PK: tenantPk(tenantId),
      SK: clientSk(record.clientId),
      entity: 'CLIENT',
      ...clientEmailGsi2(record.email),
      ...record,
    };
  }
}
