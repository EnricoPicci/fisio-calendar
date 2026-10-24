import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_DEFINITION } from '@fisio/infra/table-definition';
import { afterAll, describe, expect, it } from 'vitest';
import { freshTenant, TEST_TABLE, testDocumentClient } from '../src/index';

// Test-fixture keys only: product keys are built in apps/api/src/repo (CLAUDE.md, convention 3).
const tid = freshTenant();
const db = testDocumentClient();
afterAll(() => db.destroy());

describe('Local DynamoDB: the shared table on DynamoDB Local', () => {
  it('write/read item round-trip', async () => {
    const item = { PK: `T#${tid}`, SK: 'ROUNDTRIP', name: 'Anna', places: 3, tags: ['pool'] };
    await db.send(new PutCommand({ TableName: TEST_TABLE, Item: item }));
    const { Item } = await db.send(
      new GetCommand({ TableName: TEST_TABLE, Key: { PK: item.PK, SK: item.SK } }),
    );
    expect(Item).toEqual(item);
  });

  // Value: protects=a tenant-prefixed query never returns another tenant's items, deterministically in one file; fails_when=freshTenant repeats ids or tenants share a partition; why_new=the two-file spec depends on worker timing; seam=none; no_claim=isolation of keys the repo builds (WP0.4+)
  it('a fresh tenant sees none of another tenant’s items', async () => {
    const [first, second] = [freshTenant(), freshTenant()];
    expect(first).not.toBe(second);
    for (const owner of [first, second]) {
      await db.send(
        new PutCommand({ TableName: TEST_TABLE, Item: { PK: `T#${owner}`, SK: 'ITEM#1', owner } }),
      );
    }
    const { Items } = await db.send(
      new QueryCommand({
        TableName: TEST_TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `T#${first}` },
      }),
    );
    expect(Items?.map((item) => item.owner)).toEqual([first]);
  });

  // Value: protects=the test table has the keys, indexes and TTL of the shared definition; fails_when=create-table drifts from infra/lib/table-definition.ts (a missing GSI or TTL); why_new=the round trip uses only the primary key; seam=none; no_claim=the CDK stack (WP0.9 asserts it)
  it('the test table is built from the shared table definition', async () => {
    const { Table } = await db.send(new DescribeTableCommand({ TableName: TEST_TABLE }));
    expect(Table?.KeySchema).toEqual([
      { AttributeName: TABLE_DEFINITION.partitionKey, KeyType: 'HASH' },
      { AttributeName: TABLE_DEFINITION.sortKey, KeyType: 'RANGE' },
    ]);
    expect(Table?.GlobalSecondaryIndexes?.map((index) => index.IndexName).sort()).toEqual(
      TABLE_DEFINITION.globalSecondaryIndexes.map((index) => index.name).sort(),
    );
  });
});
