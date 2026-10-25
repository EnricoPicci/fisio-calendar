import {
  ensureTable,
  localDynamoClient,
  localEndpoint,
  TableDefinitionMismatchError,
} from '@fisio/local/table';
import { TEST_TABLE } from './dynamo';

/**
 * Vitest global setup for every project that talks to DynamoDB: creates the test table once
 * per run (idempotent, so several projects may list it). Fails, never skips, when DynamoDB
 * Local is down or holds a table from an older definition: `pnpm test` is the complete suite.
 */
export default async function setup(): Promise<void> {
  const endpoint = localEndpoint();
  const client = localDynamoClient(endpoint);
  try {
    await ensureTable(client, TEST_TABLE);
  } catch (error) {
    // A drifted table names its own remedy; anything else most likely means the stack is down.
    const message =
      error instanceof TableDefinitionMismatchError
        ? error.message
        : `Could not prepare the test table ${TEST_TABLE} on ${endpoint} (${(error as { code?: string }).code ?? String(error)}). Is the local stack running? Start it with \`pnpm local:up\`.`;
    // A plain-string stack: Vitest 5 crashes while source-mapping a global-setup stack trace
    // (`code.charCodeAt is not a function`) and would hide this message.
    throw Object.defineProperty(new Error(message), 'stack', { value: `Error: ${message}` });
  } finally {
    client.destroy();
  }
}
