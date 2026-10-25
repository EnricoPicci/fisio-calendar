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

let shared: DynamoDBDocumentClient | undefined;

/**
 * The document client on DynamoDB Local (`DYNAMODB_ENDPOINT`, default http://127.0.0.1:8000).
 * One per spec file (Vitest loads modules afresh for each file), shared by the file's specs and
 * by the app the file builds; close it with {@link closeTestDocumentClient} in `afterAll`.
 */
export function testDocumentClient(): DynamoDBDocumentClient {
  shared ??= DynamoDBDocumentClient.from(localDynamoClient(), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return shared;
}

/** Closes the worker's client; the next {@link testDocumentClient} call opens a new one. */
export function closeTestDocumentClient(): void {
  shared?.destroy();
  shared = undefined;
}

/**
 * A tenant id no other spec file uses. Every key is prefixed with the tenant (`T#<tid>`, §6.2),
 * so a spec that writes only under its own tenant cannot see or disturb another spec's items.
 */
export function freshTenant(): string {
  return `test-${randomUUID()}`;
}
