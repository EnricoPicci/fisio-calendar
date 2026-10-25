import { type DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
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
import { z } from 'zod';
import { clientEmailGsi2, clientSk, tenantPk } from './keys';

/**
 * The client item (§6.2), as far as WP0.4 reads it: the client-status check and `GET /me`.
 * Later work packages add channels, emailStatus, consentAt, invitedAt and lastSignInAt.
 */
export const ClientRecordSchema = z.object({
  clientId: ClientIdSchema,
  name: z.string().min(1),
  email: EmailSchema,
  phone: PhoneE164Schema.optional(),
  status: ClientStatusSchema,
  locale: LocaleSchema,
  createdAt: IsoDateTimeSchema,
});
export type ClientRecord = z.infer<typeof ClientRecordSchema>;

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

  /** Writes the whole client item (WP0.6 adds the add-client transaction with its outbox item). */
  async put(tenantId: TenantId, client: ClientRecord): Promise<void> {
    const record = ClientRecordSchema.parse(client);
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          PK: tenantPk(tenantId),
          SK: clientSk(record.clientId),
          entity: 'CLIENT',
          ...clientEmailGsi2(record.email),
          ...record,
        },
      }),
    );
  }
}
