import {
  CreateTableCommand,
  type CreateTableCommandInput,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ResourceInUseException,
  ResourceNotFoundException,
  type TableDescription,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { TABLE_DEFINITION } from '@fisio/infra/table-definition';

/**
 * DynamoDB Local helpers shared by `pnpm local:up` (create-table) and the testkit. The table
 * comes from the shared definition in infra/lib/table-definition.ts (docs/architecture.md §11.4).
 */
export const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:8000';

/** An existing table whose keys, indexes or TTL attribute differ from the shared definition. */
export class TableDefinitionMismatchError extends Error {
  override readonly name = 'TableDefinitionMismatchError';
}

/**
 * A client for DynamoDB Local: fixed region and dummy credentials, never the real account. A
 * blank `DYNAMODB_ENDPOINT` counts as unset (an empty endpoint would make the SDK resolve the
 * real regional endpoint). Short timeouts so a stalled container fails a run instead of hanging.
 */
export function localDynamoClient(
  endpoint: string = process.env.DYNAMODB_ENDPOINT || DEFAULT_LOCAL_ENDPOINT,
): DynamoDBClient {
  return new DynamoDBClient({
    endpoint,
    region: 'eu-central-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 2_000, requestTimeout: 5_000 },
  });
}

/** The CreateTable request for `name`, derived from the shared definition. */
export function createTableInput(name: string): CreateTableCommandInput {
  const definition = TABLE_DEFINITION;
  const keyNames = new Set([definition.partitionKey, definition.sortKey]);
  for (const index of definition.globalSecondaryIndexes) {
    keyNames.add(index.partitionKey);
    keyNames.add(index.sortKey);
  }
  return {
    TableName: name,
    BillingMode: definition.billingMode,
    AttributeDefinitions: [...keyNames].map((AttributeName) => ({
      AttributeName,
      AttributeType: 'S',
    })),
    KeySchema: [
      { AttributeName: definition.partitionKey, KeyType: 'HASH' },
      { AttributeName: definition.sortKey, KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: definition.globalSecondaryIndexes.map((index) => ({
      IndexName: index.name,
      KeySchema: [
        { AttributeName: index.partitionKey, KeyType: 'HASH' },
        { AttributeName: index.sortKey, KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    })),
  };
}

type Schema = Pick<
  TableDescription,
  'AttributeDefinitions' | 'KeySchema' | 'GlobalSecondaryIndexes'
>;

/** Keys, attribute types and indexes in a canonical order, for comparing two schemas. */
function schemaFingerprint(schema: Schema): string {
  const keys = (keySchema: Schema['KeySchema']) =>
    (keySchema ?? []).map(({ AttributeName, KeyType }) => [AttributeName, KeyType]);
  return JSON.stringify({
    keys: keys(schema.KeySchema),
    attributes: (schema.AttributeDefinitions ?? [])
      .map(({ AttributeName, AttributeType }) => [AttributeName, AttributeType])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
    indexes: (schema.GlobalSecondaryIndexes ?? [])
      .map((index) => [index.IndexName, keys(index.KeySchema), index.Projection?.ProjectionType])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  });
}

function mismatch(name: string, what: string): TableDefinitionMismatchError {
  return new TableDefinitionMismatchError(
    `Table ${name} does not match infra/lib/table-definition.ts (${what}); recreate the local stack with \`pnpm local:down && pnpm local:up\``,
  );
}

/** Turns on TTL for the shared attribute unless it is on already (or a concurrent call won). */
async function ensureTimeToLive(client: DynamoDBClient, name: string): Promise<void> {
  const attribute = TABLE_DEFINITION.timeToLiveAttribute;
  const describe = async () =>
    (await client.send(new DescribeTimeToLiveCommand({ TableName: name }))).TimeToLiveDescription;
  const isOn = (status: string | undefined) => status === 'ENABLED' || status === 'ENABLING';
  const current = await describe();
  if (isOn(current?.TimeToLiveStatus)) {
    if (current?.AttributeName !== attribute) throw mismatch(name, 'TTL attribute');
    return;
  }
  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: name,
        TimeToLiveSpecification: { AttributeName: attribute, Enabled: true },
      }),
    );
  } catch (error) {
    // DynamoDB refuses to enable TTL twice: accept it when a concurrent call enabled ours.
    const after = await describe();
    if (!isOn(after?.TimeToLiveStatus) || after?.AttributeName !== attribute) throw error;
  }
}

/**
 * Creates the table if it does not exist yet, waits until it is active and turns on TTL. An
 * existing table must match the shared definition (a long-running container keeps a table
 * created from an older definition), else TableDefinitionMismatchError; missing TTL is repaired.
 * Safe to call from several processes at once: a concurrent create is treated as success.
 * Returns true when this call created the table.
 */
export async function ensureTable(client: DynamoDBClient, name: string): Promise<boolean> {
  let existing: TableDescription | undefined;
  try {
    existing = (await client.send(new DescribeTableCommand({ TableName: name }))).Table;
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }
  let created = false;
  if (existing) {
    if (schemaFingerprint(existing) !== schemaFingerprint(createTableInput(name))) {
      throw mismatch(name, 'keys or indexes');
    }
  } else {
    try {
      await client.send(new CreateTableCommand(createTableInput(name)));
      created = true;
    } catch (createError) {
      if (!(createError instanceof ResourceInUseException)) throw createError;
    }
  }
  await waitUntilTableExists(
    { client, minDelay: 1, maxDelay: 2, maxWaitTime: 30 },
    { TableName: name },
  );
  await ensureTimeToLive(client, name);
  return created;
}
