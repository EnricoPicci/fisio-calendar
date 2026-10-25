import { fileURLToPath } from 'node:url';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isAuthErrorCode } from '@fisio/contracts';
import { type Clock, type NotificationChannel, systemClock } from '@fisio/domain';
import { tableName } from '@fisio/infra/table-definition';
import { localDynamoClient } from '@fisio/local/table';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { DEFAULT_EMULATOR_CONFIG, type EmulatorConfig, LOCAL_EMULATOR_PORT } from './config';
import { AuthEmulator, AuthError } from './emulator';
import { RsaSigner } from './jwt';
import { EmulatorStore } from './store';

/**
 * The emulator over HTTP, for `pnpm dev` (docs/architecture.md §11.4): the JWKS the API verifies
 * against and the sign-in steps the SPA's `LocalAuthService` (WP0.7) calls. Routes sit under the
 * issuer's path, so `<issuer>/.well-known/jwks.json` is the JWKS, as on Cognito. A refused step
 * answers 400 `{ code }` with an auth error code; nothing else is ever in the body.
 */
const EmailBody = z.object({ email: z.string().min(1).max(320) }).strict();
const AnswerBody = z
  .object({ session: z.string().min(1), code: z.string().min(1).max(16) })
  .strict();
const PasswordBody = z
  .object({ email: z.string().min(1).max(320), password: z.string().min(1).max(256) })
  .strict();
const SetupBody = z
  .object({ code: z.string().min(1).max(128), password: z.string().min(1).max(256) })
  .strict();
const RefreshBody = z.object({ refreshToken: z.string().min(1).max(256) }).strict();

/** The Vite dev server (WP0.7), the only browser origin that calls the emulator. */
const DEV_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

export function createEmulatorApp(emulator: AuthEmulator, config: EmulatorConfig): Hono {
  const base = new URL(config.issuer).pathname.replace(/\/+$/, '');
  const app = new Hono();
  app.use('*', cors({ origin: DEV_ORIGINS, allowMethods: ['GET', 'POST'] }));

  const routes = new Hono();
  routes.get('/.well-known/jwks.json', (c) => c.json(emulator.jwks));
  routes.post('/email-otp', async (c) =>
    c.json(await emulator.startEmailOtp(EmailBody.parse(await c.req.json()).email)),
  );
  routes.post('/email-otp/answer', async (c) => {
    const body = AnswerBody.parse(await c.req.json());
    return c.json(await emulator.answerEmailOtp(body.session, body.code));
  });
  routes.post('/password', async (c) => {
    const body = PasswordBody.parse(await c.req.json());
    return c.json(await emulator.signInWithPassword(body.email, body.password));
  });
  routes.post('/totp/answer', async (c) => {
    const body = AnswerBody.parse(await c.req.json());
    return c.json(await emulator.answerTotp(body.session, body.code));
  });
  routes.post('/setup', async (c) => {
    const body = SetupBody.parse(await c.req.json());
    return c.json(await emulator.startSetup(body.code, body.password));
  });
  routes.post('/setup/verify', async (c) => {
    const body = AnswerBody.parse(await c.req.json());
    return c.json(await emulator.verifyTotpSetup(body.session, body.code));
  });
  routes.post('/refresh', async (c) =>
    c.json(await emulator.refresh(RefreshBody.parse(await c.req.json()).refreshToken)),
  );

  app.route(base, routes);
  app.notFound((c) => c.json({ code: 'not_found' }, 404));
  app.onError((error, c) => {
    if (error instanceof AuthError && isAuthErrorCode(error.code)) {
      return c.json({ code: error.code }, 400);
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return c.json({ code: 'validation_failed' }, 400);
    }
    console.error(error);
    return c.json({ code: 'internal_error' }, 500);
  });
  return app;
}

/**
 * Prints one-time codes to the emulator's console. WP0.6 replaces it with `SmtpEmailChannel`, so
 * the codes land in Mailpit like every other local email.
 */
export const consoleChannel: NotificationChannel = {
  channel: 'email',
  async send(message) {
    console.log(`[auth-emulator] email to ${message.to}: ${message.subject}\n${message.text}`);
    return {};
  },
};

export interface LocalEmulatorOptions {
  readonly clock?: Clock;
  readonly channel?: NotificationChannel;
  readonly config?: EmulatorConfig;
}

/** The emulator on DynamoDB Local's `fisio-local` table, as `pnpm dev` and the seed use it. */
export function createLocalEmulator(options: LocalEmulatorOptions = {}) {
  const config = options.config ?? DEFAULT_EMULATOR_CONFIG;
  const doc = DynamoDBDocumentClient.from(localDynamoClient(), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const store = new EmulatorStore(doc, tableName('local'), config.poolId);
  const emulator = new AuthEmulator({
    store,
    signer: new RsaSigner(),
    channel: options.channel ?? consoleChannel,
    clock: options.clock ?? systemClock,
    config,
  });
  return { config, doc, store, emulator };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { config, emulator } = createLocalEmulator();
  const app = createEmulatorApp(emulator, config);
  serve({ fetch: app.fetch, port: LOCAL_EMULATOR_PORT, hostname: '127.0.0.1' }, () => {
    console.log(`auth emulator listening on ${config.issuer}`);
  });
}
