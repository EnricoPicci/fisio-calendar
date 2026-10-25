import { type DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { TenantId } from '@fisio/contracts';
import { isErrorNamed } from '@fisio/domain';
import { type JobName, jobMarkerSk, tenantPk } from './keys';

/**
 * Job markers (docs/architecture.md §5.3, §6.2): `JOB#<name>#<date>` records that a once-a-day
 * job finished for a local date. A job checks the marker first and writes it **last**, after its
 * idempotent puts, so a crash in between makes the next tick redo the work without duplicates
 * (catch-up semantics). Used by reminders, digest and extend-horizon (WP1.2, WP2.3, WP2.4).
 */
export const JOB_MARKER_TTL_DAYS = 7;

export class JobMarkerRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  /** True once the job has finished for `date` (a local `yyyy-mm-dd`). */
  async has(tenantId: TenantId, name: JobName, date: string): Promise<boolean> {
    const { Item } = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: tenantPk(tenantId), SK: jobMarkerSk(name, date) },
        ConsistentRead: true,
        ProjectionExpression: 'PK',
      }),
    );
    return Item !== undefined;
  }

  /** Records the run; writing it again keeps the first `ranAt`. */
  async put(tenantId: TenantId, name: JobName, date: string, ranAt: Date): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            PK: tenantPk(tenantId),
            SK: jobMarkerSk(name, date),
            entity: 'JOB_MARKER',
            ranAt: ranAt.toISOString(),
            ttl: Math.floor(ranAt.getTime() / 1000) + JOB_MARKER_TTL_DAYS * 86_400,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    } catch (error) {
      if (!isErrorNamed(error, 'ConditionalCheckFailedException')) throw error;
    }
  }
}
