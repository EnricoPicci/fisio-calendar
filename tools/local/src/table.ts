import {
  CreateTableCommand,
  type CreateTableCommandInput,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { TABLE_DEFINITION, type TableDefinition } from '@fisio/infra/table-definition';

/**
 * DynamoDB Local helpers shared by `pnpm local:up` (create-table) and the testkit. The table
 * comes from the shared definition in infra/lib/table-definition.ts (docs/architecture.md §11.4).
 */
export const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:8000';

/** A client for DynamoDB Local: fixed region and dummy credentials, never the real account. */
export function localDynamoClient(
  endpoint: string = process.env.DYNAMODB_ENDPOINT ?? DEFAULT_LOCAL_ENDPOINT,
): DynamoDBClient {
  return new DynamoDBClient({
    endpoint,
    region: 'eu-central-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    maxAttempts: 1,
  });
}

/** The CreateTable request for `name`, derived from the shared definition. */
export function createTableInput(
  name: string,
  definition: TableDefinition = TABLE_DEFINITION,
): CreateTableCommandInput {
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

/**
 * Creates the table if it does not exist yet, waits until it is active and turns on TTL.
 * Safe to call from several processes at once: a concurrent create is treated as success.
 * Returns true when this call created the table.
 */
export async function ensureTable(
  client: DynamoDBClient,
  name: string,
  definition: TableDefinition = TABLE_DEFINITION,
): Promise<boolean> {
  let created = false;
  try {
    await client.send(new DescribeTableCommand({ TableName: name }));
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
    try {
      await client.send(new CreateTableCommand(createTableInput(name, definition)));
      created = true;
    } catch (createError) {
      if (!(createError instanceof ResourceInUseException)) throw createError;
    }
  }
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: name });
  if (created) {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: name,
        TimeToLiveSpecification: { AttributeName: definition.timeToLiveAttribute, Enabled: true },
      }),
    );
  }
  return created;
}
