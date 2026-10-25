import { type DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { TenantId } from '@fisio/contracts';
import { SETTINGS_SK, tenantPk } from './keys';

/**
 * The tenant's Settings item (§6.2). WP0.4 needs only its existence: a therapist token is
 * accepted only while the item exists (§8.2). The bootstrap CLI (WP0.5) writes it with the
 * defaults, and WP1.1 gives it its fields.
 */
export class SettingsRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async exists(tenantId: TenantId): Promise<boolean> {
    const { Item } = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: tenantPk(tenantId), SK: SETTINGS_SK },
        ConsistentRead: true,
        ProjectionExpression: 'PK',
      }),
    );
    return Item !== undefined;
  }

  /** Creates the item if it is missing; an existing one is left as it is. */
  async create(tenantId: TenantId, now: Date): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            PK: tenantPk(tenantId),
            SK: SETTINGS_SK,
            entity: 'SETTINGS',
            createdAt: now.toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    } catch (error) {
      if ((error as { name?: unknown }).name !== 'ConditionalCheckFailedException') throw error;
    }
  }
}
