import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DEFAULT_EMULATOR_CONFIG,
  EmulatorStore,
  LOCAL_POOL_ID,
  LOCAL_WEB_ORIGINS,
  LocalIdentityProvider,
} from '@fisio/auth-emulator';
import { DEFAULT_TENANT_ID, type TenantId, TenantIdSchema } from '@fisio/contracts';
import {
  type Clock,
  FixedClock,
  InProcessAsyncInvoker,
  type NotificationChannel,
  systemClock,
} from '@fisio/domain';
import { SmtpEmailChannel } from '@fisio/local/smtp';
import { serve } from '@hono/node-server';
import { type Env, loadConfig } from '../config';
import { API_BASE_PATH, type ApiApp, createApp } from '../http/app';
import { type DevHooks, registerDevRoutes } from '../http/dev';
import { consoleErrorLogger } from '../http/router';
import { createTokenVerifier, fetchJwks } from '../identity/token-verifier';
import { consoleTickLog, deliveryJobs, runTick, type TickReport } from '../jobs/tick';
import { consoleNotifierLog, createNotifierHandler, Notifier } from '../notify/notifier';
import { ClientRepository } from '../repo/clients';
import { NotificationRepository } from '../repo/notifications';
import { SettingsRepository } from '../repo/settings';

/**
 * Composition root for the local stack (docs/architecture.md §11.4): the same app on Node with
 * DynamoDB Local, the auth emulator's tokens and users (WP0.5), email through Mailpit
 * (`SmtpEmailChannel`), the notifier in-process (`InProcessAsyncInvoker`), and the `/__dev/*`
 * routes running the real tick and delivery. `pnpm dev` runs this file; `.env.local` at the
 * repository root overrides the defaults below.
 */
export const LOCAL_DEFAULTS: Env = {
  STAGE: 'local',
  // tableName('local') in infra/lib/table-definition.ts, which `pnpm local:up` creates.
  TABLE_NAME: 'fisio-local',
  DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000',
  // The auth emulator (WP0.5) issues and publishes its keys here.
  AUTH_ISSUER: 'http://127.0.0.1:9100/local',
  AUTH_CLIENT_ID: DEFAULT_EMULATOR_CONFIG.clientId,
  // The Vite dev server (WP0.7): invitation links point there.
  WEB_ORIGIN: LOCAL_WEB_ORIGINS[0],
};

/** The one tenant of the local stack, as the emulator's tokens and the seed use it. */
export const LOCAL_TENANT_ID: TenantId = TenantIdSchema.parse(DEFAULT_TENANT_ID);

export interface LocalAppOptions {
  readonly clock?: Clock;
  /** Replaces the real tick and delivery behind `/__dev/*` (runtime specs). */
  readonly devHooks?: DevHooks;
  /** Where email goes; Mailpit through SMTP by default. */
  readonly channel?: NotificationChannel;
  /** The tenant the dev routes tick for; {@link LOCAL_TENANT_ID} by default (specs use their own). */
  readonly tenantId?: TenantId;
}

export function createLocalApp(env: Env, options: LocalAppOptions = {}): ApiApp {
  const config = loadConfig({ ...LOCAL_DEFAULTS, ...definedOnly(env) });
  const clock = options.clock ?? systemClock;
  const tenantId = options.tenantId ?? LOCAL_TENANT_ID;
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      // Never the real AWS endpoint: a fixed local endpoint, region and dummy credentials.
      endpoint: config.dynamoEndpoint ?? LOCAL_DEFAULTS.DYNAMODB_ENDPOINT,
      region: 'eu-central-1',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  const channel = options.channel ?? new SmtpEmailChannel();
  const notifications = new NotificationRepository(doc, config.tableName);
  const notifierAt = localNotifierAt(notifications, channel);
  const handler = createNotifierHandler(notifierAt(clock), consoleNotifierLog);
  // A long-running server never calls `settled()`: log a failed run instead of collecting it.
  const invoker = new InProcessAsyncInvoker({
    notifier: (event) => handler(event).catch(consoleErrorLogger),
  });
  const devHooks: DevHooks = options.devHooks ?? {
    tick: async (now) => {
      await localTick({ notifierAt, now, tenantId });
    },
    deliver: async () => {
      const notifier = notifierAt(clock);
      await notifier.sweep(tenantId);
      await notifier.deliverDue(tenantId);
    },
  };
  return createApp(
    {
      clock,
      log: consoleErrorLogger,
      tokens: createTokenVerifier(config.auth, { clock, fetcher: fetchJwks }),
      clients: new ClientRepository(doc, config.tableName),
      settings: new SettingsRepository(doc, config.tableName),
      identity: new LocalIdentityProvider(
        new EmulatorStore(doc, config.tableName, LOCAL_POOL_ID),
        clock,
        DEFAULT_EMULATOR_CONFIG,
      ),
      notifications,
      invoker,
      webOrigin: config.webOrigin,
    },
    { extend: (api, deps) => registerDevRoutes(api, deps, devHooks) },
  );
}

/** The local notifier at a given clock: email through `channel`, log lines to the console. */
export function localNotifierAt(
  notifications: NotificationRepository,
  channel: NotificationChannel,
): (clock: Clock) => Notifier {
  return (clock) =>
    new Notifier({ notifications, channels: { email: channel }, clock, log: consoleNotifierLog });
}

/**
 * One tick of the real jobs code at `now` (`/__dev/tick`, `pnpm tick --now`): the clock stands
 * at `now` for the jobs and for the notifier they start in-process, which the tick waits for.
 */
export async function localTick(options: {
  readonly notifierAt: (clock: Clock) => Notifier;
  readonly now: Date;
  readonly tenantId: TenantId;
}): Promise<TickReport> {
  const clock = new FixedClock(options.now);
  const invoker = new InProcessAsyncInvoker({
    notifier: createNotifierHandler(options.notifierAt(clock), consoleNotifierLog),
  });
  const report = await runTick(
    deliveryJobs(invoker),
    { tenantId: options.tenantId, now: clock.now() },
    consoleTickLog,
  );
  await invoker.settled();
  return report;
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
