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
 * The DynamoDB Local endpoint: `DYNAMODB_ENDPOINT`, else http://localhost:8000. A blank value
 * counts as unset: an empty endpoint would make the SDK resolve the real regional endpoint.
 */
export function localEndpoint(): string {
  return process.env.DYNAMODB_ENDPOINT || DEFAULT_LOCAL_ENDPOINT;
}

/**
 * A client for DynamoDB Local: fixed region and dummy credentials, never the real account.
 * Short timeouts that reject (`throwOnRequestTimeout`; without it the SDK only logs a warning),
 * so a stalled container fails a run instead of hanging it.
 */
export function localDynamoClient(endpoint: string = localEndpoint()): DynamoDBClient {
  return new DynamoDBClient({
    endpoint,
    region: 'eu-central-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: 2_000,
      requestTimeout: 5_000,
      throwOnRequestTimeout: true,
    },
  });
}

/** The CreateTable request for `name`, derived from the shared definition. */
export function createTableInput(name: string): CreateTableCommandInput {
  const keyNames = new Set([TABLE_DEFINITION.partitionKey, TABLE_DEFINITION.sortKey]);
  for (const index of TABLE_DEFINITION.globalSecondaryIndexes) {
    keyNames.add(index.partitionKey);
    keyNames.add(index.sortKey);
  }
  return {
    TableName: name,
    BillingMode: TABLE_DEFINITION.billingMode,
    AttributeDefinitions: [...keyNames].map((AttributeName) => ({
      AttributeName,
      AttributeType: 'S',
    })),
    KeySchema: [
      { AttributeName: TABLE_DEFINITION.partitionKey, KeyType: 'HASH' },
      { AttributeName: TABLE_DEFINITION.sortKey, KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: TABLE_DEFINITION.globalSecondaryIndexes.map((index) => ({
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
    `Table ${name} does not match infra/lib/table-definition.ts (${what}); delete that table (the next run recreates it) or rebuild the local stack with \`pnpm local:down && pnpm local:up\`, which also drops seeded data`,
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
    // DynamoDB refuses to enable TTL twice: accept it when a concurrent call enabled ours. A
    // failing re-check must not hide why the update failed.
    const after = await describe().catch(() => undefined);
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
