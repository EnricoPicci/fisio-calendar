import { randomUUID } from 'node:crypto';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '@fisio/infra/table-definition';
import { localDynamoClient } from '@fisio/local/table';

/**
 * DynamoDB Local for specs (docs/architecture.md §10.3): one shared table, created once per
 * `pnpm test` run by the global setup, and a fresh tenant id per spec file, so spec files run
 * in parallel without truncation or cleanup.
 */
export const TEST_TABLE = tableName('test');

/** A document client on DynamoDB Local (`DYNAMODB_ENDPOINT`, default http://localhost:8000). */
export function testDocumentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(localDynamoClient(), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/**
 * A tenant id no other spec file uses. Every key is prefixed with the tenant (`T#<tid>`, §6.2),
 * so a spec that writes only under its own tenant cannot see or disturb another spec's items.
 */
export function freshTenant(): string {
  return `test-${randomUUID()}`;
}
