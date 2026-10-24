/**
 * The single DynamoDB table (docs/architecture.md §6.2, §6.4), as plain data. The CDK
 * `Stateful` stack (WP0.9) and the local `create-table` script both build the table from this
 * object, so the local schema cannot drift from the deployed one.
 *
 * Keys are generic strings: every item has `PK`/`SK`, and the entities listed in §6.2 fill the
 * index attributes `GSI1PK`/`GSI1SK` (a client's bookings) and `GSI2PK`/`GSI2SK` (clients by
 * email). Key values are built only in `apps/api/src/repo`.
 */
export interface IndexDefinition {
  readonly name: string;
  readonly partitionKey: string;
  readonly sortKey: string;
}

export interface TableDefinition {
  readonly partitionKey: string;
  readonly sortKey: string;
  readonly globalSecondaryIndexes: readonly IndexDefinition[];
  /** Attribute holding an epoch-seconds expiry (notifications, audit, job markers). */
  readonly timeToLiveAttribute: string;
  readonly billingMode: 'PAY_PER_REQUEST';
}

export const TABLE_DEFINITION: TableDefinition = {
  partitionKey: 'PK',
  sortKey: 'SK',
  globalSecondaryIndexes: [
    { name: 'GSI1', partitionKey: 'GSI1PK', sortKey: 'GSI1SK' },
    { name: 'GSI2', partitionKey: 'GSI2PK', sortKey: 'GSI2SK' },
  ],
  timeToLiveAttribute: 'ttl',
  billingMode: 'PAY_PER_REQUEST',
};

/** `fisio-<stage>`, e.g. `fisio-dev`, `fisio-prod`, `fisio-local`, `fisio-test`. */
export function tableName(stage: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(stage)) {
    throw new RangeError(`Invalid stage "${stage}": lower-case letters, digits and dashes only`);
  }
  return `fisio-${stage}`;
}
