import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, expect, it } from 'vitest';
import { closeTestDocumentClient, freshTenant, TEST_TABLE, testDocumentClient } from '../src/index';

/**
 * Body of the two tenant-isolation spec files (§10.3). Both files run in parallel workers and
 * write the same sort keys; each must read back only the items of its own tenant.
 * Test-fixture keys only: product keys are built in apps/api/src/repo.
 */
export function tenantIsolationSpec(file: string): void {
  const tid = freshTenant();
  const db = testDocumentClient();
  afterAll(closeTestDocumentClient);

  it("two spec files with different tenants do not see each other's items", async () => {
    const sortKeys = ['ITEM#1', 'ITEM#2', 'ITEM#3'];
    for (const SK of sortKeys) {
      await db.send(new PutCommand({ TableName: TEST_TABLE, Item: { PK: `T#${tid}`, SK, file } }));
    }
    const { Items } = await db.send(
      new QueryCommand({
        TableName: TEST_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :item)',
        ExpressionAttributeValues: { ':pk': `T#${tid}`, ':item': 'ITEM#' },
      }),
    );
    expect(Items?.map((item) => item.SK)).toEqual(sortKeys);
    expect(Items?.every((item) => item.file === file)).toBe(true);
  });
}
