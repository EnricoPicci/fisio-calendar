import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { systemClock } from '@fisio/domain';
import { type AppDeps, createApp, openApiDocument } from './http/app';
import { consoleErrorLogger } from './http/router';

/**
 * `docs/openapi.json` (docs/architecture.md §5.2), generated from the route declarations of the
 * deployed API (no `/__dev/*`). `pnpm openapi` writes it; a spec fails when the committed file
 * is out of date, and the SPA's typed client (WP0.7) is generated from it.
 */
export const OPENAPI_FILE = fileURLToPath(new URL('../../../docs/openapi.json', import.meta.url));

/** Building the document registers routes but serves none, so the ports are never called. */
const unused = (): never => {
  throw new Error('Not available while generating the OpenAPI document');
};
const unusedPort = <T>() =>
  new Proxy({}, { get: (_, name) => (name === 'then' ? undefined : unused) }) as T;
const documentationDeps: Omit<AppDeps, 'clock' | 'log'> = {
  tokens: { verify: unused },
  clients: unusedPort(),
  settings: unusedPort(),
  identity: unusedPort(),
  notifications: unusedPort(),
  invoker: unusedPort(),
  webOrigin: 'https://fisio.invalid',
};

export function renderOpenApiJson(): string {
  const { api } = createApp({ ...documentationDeps, clock: systemClock, log: consoleErrorLogger });
  return `${JSON.stringify(openApiDocument(api), null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(OPENAPI_FILE, renderOpenApiJson());
  console.log(`wrote ${OPENAPI_FILE}`);
}
