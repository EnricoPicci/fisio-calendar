import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  type DynamoDBClient,
  ResourceInUseException,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { TABLE_DEFINITION, tableName } from '@fisio/infra/table-definition';
import {
  createTableInput,
  ensureTable,
  localDynamoClient,
  TableDefinitionMismatchError,
} from '@fisio/local/table';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import globalSetup from '../src/global-setup';

// Fresh tables per spec, never fisio-test or fisio-local: those are shared by the whole run.
const client = localDynamoClient();
const made: string[] = [];
function freshTable(): string {
  const name = tableName(`cov-${randomUUID()}`);
  made.push(name);
  return name;
}
afterAll(async () => {
  await Promise.allSettled(
    made.map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
  client.destroy();
});

async function ttlStatus(name: string) {
  const { TimeToLiveDescription } = await client.send(
    new DescribeTimeToLiveCommand({ TableName: name }),
  );
  return TimeToLiveDescription;
}

const createTableScript = fileURLToPath(
  new URL('../../../tools/local/src/create-table.ts', import.meta.url),
);
function runCreateTable(stage: string, endpoint?: string): number | null {
  const env = { ...process.env, ...(endpoint ? { DYNAMODB_ENDPOINT: endpoint } : {}) };
  return spawnSync(process.execPath, [createTableScript, stage], {
    env,
    encoding: 'utf8',
    timeout: 15_000,
  }).status;
}

describe('Local DynamoDB: ensureTable creates the table once, from the shared definition', () => {
  // Value: protects=a new table is ACTIVE with TTL on the shared attribute, and a second call is a no-op reporting created=false; fails_when=TTL is skipped or the created flag is wrong; why_new=the shared fisio-test table predates every spec, so no spec sees creation; seam=none; no_claim=TTL expiry itself (DynamoDB Local does not delete expired items)
  it('creates a missing table with TTL enabled, and a second call finds it', async () => {
    const name = freshTable();
    expect(await ensureTable(client, name)).toBe(true);
    const { Table } = await client.send(new DescribeTableCommand({ TableName: name }));
    expect(Table?.TableStatus).toBe('ACTIVE');
    expect(await ttlStatus(name)).toMatchObject({
      AttributeName: TABLE_DEFINITION.timeToLiveAttribute,
      TimeToLiveStatus: 'ENABLED',
    });
    expect(await ensureTable(client, name)).toBe(false);
  });

  // Value: protects=parallel Vitest projects creating the same table all succeed, exactly one reports creating it; fails_when=ResourceInUseException is no longer treated as success; why_new=one global setup per run never races; seam=none (the client is a parameter); no_claim=races across separate DynamoDB Local instances
  it('concurrent calls for the same missing table all succeed and only one creates it', async () => {
    const name = freshTable();
    // Hold every CreateTable until all three DescribeTable calls have missed the table, so the
    // race always happens and two of the creates hit ResourceInUseException.
    let missed = 0;
    let releaseCreates!: () => void;
    const allMissed = new Promise<void>((resolve) => {
      releaseCreates = resolve;
    });
    const inUse: unknown[] = [];
    const racing = {
      send: async (command: Parameters<DynamoDBClient['send']>[0]) => {
        const isCreate = command instanceof CreateTableCommand;
        if (isCreate) await allMissed;
        try {
          return await client.send(command);
        } catch (error) {
          if (isCreate) inUse.push(error);
          else if (error instanceof ResourceNotFoundException && ++missed === 3) releaseCreates();
          throw error;
        }
      },
    } as unknown as DynamoDBClient;
    const results = await Promise.all([1, 2, 3].map(() => ensureTable(racing, name)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(inUse).toHaveLength(2);
    for (const error of inUse) expect(error).toBeInstanceOf(ResourceInUseException);
    // The three calls also race to enable TTL; the losers must accept the winner's TTL.
    expect(await ttlStatus(name)).toMatchObject({
      AttributeName: TABLE_DEFINITION.timeToLiveAttribute,
      TimeToLiveStatus: 'ENABLED',
    });
  });

  // Value: protects=a table left without TTL (the creating call died before enabling it) is repaired by the next call; fails_when=ensureTable enables TTL only on the call that created the table; why_new=every other spec sees a table some call created in full; seam=none; no_claim=TTL expiry itself
  it('turns on TTL for an existing table that lacks it', async () => {
    const name = freshTable();
    await client.send(new CreateTableCommand(createTableInput(name)));
    await waitUntilTableExists({ client, minDelay: 1, maxWaitTime: 30 }, { TableName: name });
    expect(await ensureTable(client, name)).toBe(false);
    expect(await ttlStatus(name)).toMatchObject({
      AttributeName: TABLE_DEFINITION.timeToLiveAttribute,
      TimeToLiveStatus: 'ENABLED',
    });
  });

  // Value: protects=a table built from an older definition (still in a long-running container) is refused, not silently reused; fails_when=the found path stops comparing keys and indexes with the shared definition; why_new=no other spec creates a drifted table; seam=none; no_claim=drift of the deployed table (WP0.9 assertions)
  it('refuses an existing table whose indexes differ from the definition', async () => {
    const name = freshTable();
    const { GlobalSecondaryIndexes, ...withoutIndexes } = createTableInput(name);
    expect(GlobalSecondaryIndexes?.length).toBeGreaterThan(0);
    await client.send(
      new CreateTableCommand({
        ...withoutIndexes,
        AttributeDefinitions: [
          { AttributeName: TABLE_DEFINITION.partitionKey, AttributeType: 'S' },
          { AttributeName: TABLE_DEFINITION.sortKey, AttributeType: 'S' },
        ],
      }),
    );
    await expect(ensureTable(client, name)).rejects.toBeInstanceOf(TableDefinitionMismatchError);
  });

  // Value: protects=a table whose TTL is on another attribute (items would expire on the wrong field) is refused, not silently reused; fails_when=the TTL attribute check is dropped or loosened; why_new=every other spec's table has TTL on ttl or off; seam=none; no_claim=TTL expiry itself
  it('refuses an existing table whose TTL is on another attribute', async () => {
    const name = freshTable();
    await client.send(new CreateTableCommand(createTableInput(name)));
    await waitUntilTableExists({ client, minDelay: 1, maxWaitTime: 30 }, { TableName: name });
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: name,
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      }),
    );
    await expect(ensureTable(client, name)).rejects.toBeInstanceOf(TableDefinitionMismatchError);
  });
});

describe('Local DynamoDB: the create-table step of `pnpm local:up`', () => {
  // Value: protects=create-table exits 0 when it creates or finds the table, so `pnpm local:up` can run twice; fails_when=a second run fails on the existing table; why_new=no spec runs the CLI; seam=none; no_claim=the docker compose step
  it('exits 0 on first and repeated runs', () => {
    const stage = `cov-${randomUUID()}`;
    made.push(tableName(stage));
    expect(runCreateTable(stage)).toBe(0);
    expect(runCreateTable(stage)).toBe(0);
  });

  // Value: protects=`pnpm local:up` stops with a non-zero exit when DynamoDB Local is unreachable; fails_when=the catch drops process.exitCode=1 and the && chain reports success; why_new=no spec runs the CLI; seam=none; no_claim=the wording of the error line
  it('exits non-zero when DynamoDB Local is unreachable', () => {
    expect(runCreateTable(`cov-${randomUUID()}`, 'http://127.0.0.1:9')).toBe(1);
  });

  // Value: protects=a malformed stage argument fails the step and creates no table; fails_when=the CLI stops validating the stage and creates fisio-Dev; why_new=no spec runs the CLI with a bad stage; seam=none; no_claim=the wording of the error
  it('exits non-zero and creates no table for an invalid stage', async () => {
    made.push('fisio-Dev');
    expect(runCreateTable('Dev')).not.toBe(0);
    await expect(
      client.send(new DescribeTableCommand({ TableName: 'fisio-Dev' })),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });
});

describe('Local DynamoDB: the Vitest global setup', () => {
  const saved = process.env.DYNAMODB_ENDPOINT;
  afterEach(() => {
    if (saved === undefined) delete process.env.DYNAMODB_ENDPOINT;
    else process.env.DYNAMODB_ENDPOINT = saved;
  });

  // Value: protects=`pnpm test` fails, never skips, when DynamoDB Local is down, with a plain Error whose stack is a single string (the Vitest 5 workaround); fails_when=the catch swallows the error or rethrows the raw SDK error; why_new=every run has DynamoDB up; seam=none; no_claim=message wording
  it('rejects when DynamoDB Local is unreachable', async () => {
    process.env.DYNAMODB_ENDPOINT = 'http://127.0.0.1:9';
    const error = await globalSetup().then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).constructor).toBe(Error);
    expect((error as Error).stack?.startsWith('Error: ')).toBe(true);
    expect((error as Error).stack).not.toContain('\n    at ');
  });
});
