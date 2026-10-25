import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { type Clock, systemClock } from '@fisio/domain';
import { serve } from '@hono/node-server';
import { type Env, loadConfig } from '../config';
import { API_BASE_PATH, type ApiApp, createApp } from '../http/app';
import { type DevHooks, noDevHooks, registerDevRoutes } from '../http/dev';
import { consoleErrorLogger } from '../http/router';
import { createTokenVerifier, fetchJwks } from '../identity/token-verifier';
import { ClientRepository } from '../repo/clients';
import { SettingsRepository } from '../repo/settings';

/**
 * Composition root for the local stack (docs/architecture.md §11.4): the same app on Node with
 * DynamoDB Local, the auth emulator's tokens (WP0.5) and the `/__dev/*` routes. `pnpm dev`
 * runs this file; `.env.local` at the repository root overrides the defaults below.
 */
export const LOCAL_DEFAULTS: Env = {
  STAGE: 'local',
  // tableName('local') in infra/lib/table-definition.ts, which `pnpm local:up` creates.
  TABLE_NAME: 'fisio-local',
  DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000',
  // The auth emulator (WP0.5) issues and publishes its keys here.
  AUTH_ISSUER: 'http://127.0.0.1:9100/local',
  AUTH_CLIENT_ID: 'fisio-local-web',
};

export interface LocalAppOptions {
  readonly clock?: Clock;
  readonly devHooks?: DevHooks;
}

export function createLocalApp(env: Env, options: LocalAppOptions = {}): ApiApp {
  const config = loadConfig({ ...LOCAL_DEFAULTS, ...definedOnly(env) });
  const clock = options.clock ?? systemClock;
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      // Never the real AWS endpoint: a fixed local endpoint, region and dummy credentials.
      endpoint: config.dynamoEndpoint ?? LOCAL_DEFAULTS.DYNAMODB_ENDPOINT,
      region: 'eu-central-1',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  return createApp(
    {
      clock,
      log: consoleErrorLogger,
      tokens: createTokenVerifier(config.auth, { clock, fetcher: fetchJwks }),
      clients: new ClientRepository(doc, config.tableName),
      settings: new SettingsRepository(doc, config.tableName),
    },
    {
      extend: (api, deps) => registerDevRoutes(api, deps, options.devHooks ?? noDevHooks),
    },
  );
}

function definedOnly(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

const ENV_FILE = fileURLToPath(new URL('../../../../.env.local', import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const port = Number(process.env.PORT ?? 3000);
  const { app } = createLocalApp(process.env);
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
    console.log(`api listening on http://127.0.0.1:${port}${API_BASE_PATH}`);
  });
}
