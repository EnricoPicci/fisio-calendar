// `pnpm local:up` step: create the local table from the shared definition (idempotent).
// Usage: node tools/local/src/create-table.ts [stage]   (default stage: local -> fisio-local)
// Runs through Node's type stripping, so it needs Node >= 22.18 (develop on 24, `.nvmrc`).
import { tableName } from '@fisio/infra/table-definition';
import { ensureTable, localDynamoClient, localEndpoint } from './table.ts';

const name = tableName(process.argv[2] ?? 'local');
const endpoint = localEndpoint();
const client = localDynamoClient(endpoint);
try {
  const created = await ensureTable(client, name);
  console.log(`${created ? 'Created' : 'Found'} table ${name} on ${endpoint}`);
} catch (error) {
  console.error(`Could not prepare table ${name} on ${endpoint}: ${String(error)}`);
  process.exitCode = 1;
} finally {
  client.destroy();
}
