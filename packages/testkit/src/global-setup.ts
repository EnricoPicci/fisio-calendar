import { DEFAULT_LOCAL_ENDPOINT, ensureTable, localDynamoClient } from '@fisio/local/table';
import { TEST_TABLE } from './dynamo';

/**
 * Vitest global setup for every project that talks to DynamoDB: creates the test table once
 * per run (idempotent, so several projects may list it). Fails, never skips, when DynamoDB
 * Local is down: `pnpm test` is the complete suite.
 */
export default async function setup(): Promise<void> {
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? DEFAULT_LOCAL_ENDPOINT;
  const client = localDynamoClient(endpoint);
  try {
    await ensureTable(client, TEST_TABLE);
  } catch (error) {
    const cause = (error as { code?: string; message?: string }).code ?? String(error);
    const message = `DynamoDB Local is not reachable at ${endpoint} (${cause}). Start the local stack with \`pnpm local:up\`.`;
    // A plain-string stack: Vitest 5 crashes while source-mapping a global-setup stack trace
    // (`code.charCodeAt is not a function`) and would hide this message.
    throw Object.defineProperty(new Error(message), 'stack', { value: `Error: ${message}` });
  } finally {
    client.destroy();
  }
}
