import { fileURLToPath } from 'node:url';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isAuthErrorCode } from '@fisio/contracts';
import { type NotificationChannel, systemClock } from '@fisio/domain';
import { tableName } from '@fisio/infra/table-definition';
import { SmtpEmailChannel } from '@fisio/local/smtp';
import { localDynamoClient } from '@fisio/local/table';
import { serve } from '@hono/node-server';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import {
  DEFAULT_EMULATOR_CONFIG,
  type EmulatorConfig,
  LOCAL_EMULATOR_PORT,
  LOCAL_WEB_ORIGINS,
} from './config';
import { AuthEmulator, AuthError } from './emulator';
import { RsaSigner } from './jwt';
import { EmulatorStore } from './store';

/**
 * The emulator over HTTP, for `pnpm dev` (docs/architecture.md §11.4): the JWKS the API verifies
 * against and the sign-in steps the SPA's `LocalAuthService` (WP0.7) calls. Routes sit under the
 * issuer's path, so `<issuer>/.well-known/jwks.json` is the JWKS, as on Cognito. A refused step
 * answers 400 `{ code }` with an `AuthErrorCode`. Four answers are not sign-in outcomes and carry
 * a code outside that list: 400 `validation_failed` (a malformed body, or a POST that is not
 * `application/json`), 403 `forbidden_origin` (a browser origin other than the Vite dev server),
 * 404 `not_found` and 500 `internal_error`. `LocalAuthService` (WP0.7) treats them as unexpected.
 */
const EmailBody = z.object({ email: z.string().min(1).max(320) }).strict();
const AnswerBody = z
  // A session id is 43 characters (randomToken); a longer one would break the store's key size.
  .object({ session: z.string().min(1).max(64), code: z.string().min(1).max(16) })
  .strict();
const PasswordBody = z
  .object({ email: z.string().min(1).max(320), password: z.string().min(1).max(256) })
  .strict();
const SetupBody = z
  .object({ code: z.string().min(1).max(128), password: z.string().min(1).max(256) })
  .strict();
const RefreshBody = z.object({ refreshToken: z.string().min(1).max(256) }).strict();

/** A request body that is not JSON or does not match its schema: the only 400 validation_failed. */
class MalformedBody extends Error {}

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new MalformedBody();
  return parsed.data;
}

export function createEmulatorApp(emulator: AuthEmulator, config: EmulatorConfig): Hono {
  const base = new URL(config.issuer).pathname.replace(/\/+$/, '');
  const app = new Hono();
  app.use('*', cors({ origin: LOCAL_WEB_ORIGINS, allowMethods: ['GET', 'POST'] }));
  // CORS only hides answers from other origins; these refuse the request itself, so a page on
  // another site cannot send codes or lock seeded accounts with a "simple" text/plain POST.
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !LOCAL_WEB_ORIGINS.includes(origin)) {
      return c.json({ code: 'forbidden_origin' }, 403);
    }
    if (c.req.method === 'POST' && !c.req.header('content-type')?.startsWith('application/json')) {
      return c.json({ code: 'validation_failed' }, 400);
    }
    return next();
  });

  const routes = new Hono();
  routes.get('/.well-known/jwks.json', (c) => c.json(emulator.jwks));
  routes.post('/email-otp', async (c) =>
    c.json(await emulator.startEmailOtp((await body(c, EmailBody)).email)),
  );
  routes.post('/email-otp/answer', async (c) => {
    const answer = await body(c, AnswerBody);
    return c.json(await emulator.answerEmailOtp(answer.session, answer.code));
  });
  routes.post('/password', async (c) => {
    const step = await body(c, PasswordBody);
    return c.json(await emulator.signInWithPassword(step.email, step.password));
  });
  routes.post('/totp/answer', async (c) => {
    const answer = await body(c, AnswerBody);
    return c.json(await emulator.answerTotp(answer.session, answer.code));
  });
  routes.post('/setup', async (c) => {
    const setup = await body(c, SetupBody);
    return c.json(await emulator.startSetup(setup.code, setup.password));
  });
  routes.post('/setup/verify', async (c) => {
    const answer = await body(c, AnswerBody);
    return c.json(await emulator.verifyTotpSetup(answer.session, answer.code));
  });
  routes.post('/refresh', async (c) =>
    c.json(await emulator.refresh((await body(c, RefreshBody)).refreshToken)),
  );

  app.route(base, routes);
  app.notFound((c) => c.json({ code: 'not_found' }, 404));
  app.onError((error, c) => {
    if (error instanceof AuthError && isAuthErrorCode(error.code)) {
      return c.json({ code: error.code }, 400);
    }
    if (error instanceof MalformedBody) return c.json({ code: 'validation_failed' }, 400);
    // Anything else, a stored record that fails its schema included, is the emulator's own fault.
    console.error(error);
    return c.json({ code: 'internal_error' }, 500);
  });
  return app;
}

/**
 * The emulator on DynamoDB Local's `fisio-local` table, as `pnpm dev`, the seed and the local
 * bootstrap use it. One-time codes go to Mailpit (`SmtpEmailChannel`, http://localhost:8025)
 * like every other local email, unless another channel is given.
 */
export function createLocalEmulator(options: { channel?: NotificationChannel } = {}) {
  const config = DEFAULT_EMULATOR_CONFIG;
  const doc = DynamoDBDocumentClient.from(localDynamoClient(), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const store = new EmulatorStore(doc, tableName('local'), config.poolId);
  const channel = options.channel ?? new SmtpEmailChannel();
  const emulator = new AuthEmulator({
    store,
    signer: new RsaSigner(),
    channel,
    clock: systemClock,
    config,
  });
  return { config, doc, store, emulator, channel };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { config, emulator } = createLocalEmulator();
  const app = createEmulatorApp(emulator, config);
  serve({ fetch: app.fetch, port: LOCAL_EMULATOR_PORT, hostname: '127.0.0.1' }, () => {
    console.log(`auth emulator listening on ${config.issuer}`);
  });
}
