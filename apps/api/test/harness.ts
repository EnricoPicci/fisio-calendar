import { randomUUID } from 'node:crypto';
import { createTestEmulator, type TestEmulator } from '@fisio/auth-emulator/testing';
import { ClientIdSchema, type ClientStatus, type TenantId, TenantIdSchema } from '@fisio/contracts';
import { FixedClock, InProcessAsyncInvoker } from '@fisio/domain';
import {
  FakeChannel,
  freshTenant,
  inProcessFetch,
  TEST_CLIENT_ID,
  TEST_ISSUER,
  TEST_JWKS_URI,
  TEST_TABLE,
  TestTokenIssuer,
  testDocumentClient,
} from '@fisio/testkit';
import type { AuthDeps } from '../src/http/access';
import { API_BASE_PATH, type AppOptions, createApp } from '../src/http/app';
import { createTokenVerifier, type TokenVerifier } from '../src/identity/token-verifier';
import { deliveryJobs, runTick, type TickReport } from '../src/jobs/tick';
import { createNotifierHandler, Notifier } from '../src/notify/notifier';
import { type ClientRecord, type ClientRecordInput, ClientRepository } from '../src/repo/clients';
import { JobMarkerRepository } from '../src/repo/job-markers';
import { NotificationRepository } from '../src/repo/notifications';
import { SettingsRepository } from '../src/repo/settings';

/**
 * The API spec harness (docs/architecture.md §10.1): the real app in-process (`app.request`) on
 * DynamoDB Local under a fresh tenant, at a fixed clock, with the real token verifier reading
 * the testkit issuer's JWKS from memory, the auth emulator's identity provider (a pool of its
 * own), `FakeChannel` for email and the real notifier behind an in-process `AsyncInvoker`:
 * `await h.invoker.settled()` waits for what an async invoke started. The web app's headless
 * journeys (WP0.8) build the same harness through `@fisio/api/testing`, with their own clock and
 * channel, verifying the emulator's tokens (`emulatorTokens`).
 */
export const SPEC_NOW = '2027-03-01T08:00:00.000Z';
export const SPEC_WEB_ORIGIN = 'https://fisio.test';

export interface CallOptions {
  readonly token?: string;
  readonly json?: unknown;
  /** A body sent as is, for requests that are not valid JSON. */
  readonly rawBody?: string;
  readonly headers?: Record<string, string>;
}

export interface CallResult {
  readonly status: number;
  readonly contentType: string | null;
  readonly headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: specs read response bodies freely.
  readonly body: any;
}

export interface HarnessOptions extends AppOptions {
  readonly issuer?: TestTokenIssuer;
  /** Replaces the testkit issuer's verifier, e.g. with {@link emulatorTokens}. */
  readonly tokens?: (context: {
    clock: FixedClock;
    tenantId: TenantId;
    emulator: TestEmulator;
  }) => TokenVerifier;
  /** The clock of the API, the notifier and the emulator; a new one at {@link SPEC_NOW} by default. */
  readonly clock?: FixedClock;
  /** Where every email goes, the emulator's codes included; a new `FakeChannel` by default. */
  readonly channel?: FakeChannel;
}

/** A verifier for the tokens of the harness's own auth emulator, its JWKS served from memory. */
export function emulatorTokens(context: {
  clock: FixedClock;
  emulator: TestEmulator;
}): TokenVerifier {
  const { config, signer } = context.emulator;
  return createTokenVerifier(
    {
      issuer: config.issuer,
      jwksUri: `${config.issuer}/.well-known/jwks.json`,
      clientId: config.clientId,
    },
    {
      clock: context.clock,
      fetcher: {
        fetch: async () =>
          new TextEncoder().encode(JSON.stringify(signer.jwks)).buffer as ArrayBuffer,
      },
    },
  );
}

export function apiHarness(options: HarnessOptions = {}) {
  const clock = options.clock ?? new FixedClock(SPEC_NOW);
  const issuer = options.issuer ?? new TestTokenIssuer();
  const doc = testDocumentClient();
  const tenantId: TenantId = TenantIdSchema.parse(freshTenant());
  const clients = new ClientRepository(doc, TEST_TABLE);
  const settings = new SettingsRepository(doc, TEST_TABLE);
  const notifications = new NotificationRepository(doc, TEST_TABLE);
  const markers = new JobMarkerRepository(doc, TEST_TABLE);
  const channel = options.channel ?? new FakeChannel();
  const loggedErrors: unknown[] = [];
  /** The notifier's and the tick's structured log lines, `[event, details]`. */
  const notifierLog: [string, Readonly<Record<string, unknown>>][] = [];
  const notifier = new Notifier({
    notifications,
    channels: { email: channel },
    clock,
    log: (event, details) => notifierLog.push([event, details]),
  });
  const invoker = new InProcessAsyncInvoker({
    notifier: createNotifierHandler(notifier, (event, details) =>
      notifierLog.push([event, details]),
    ),
  });
  const emulator = createTestEmulator({
    doc,
    table: TEST_TABLE,
    clock,
    channel,
    config: { poolId: freshTenant(), tenantId },
  });
  const { identity } = emulator;
  const auth: AuthDeps = {
    clock,
    tokens:
      options.tokens?.({ clock, tenantId, emulator }) ??
      createTokenVerifier(
        { issuer: TEST_ISSUER, jwksUri: TEST_JWKS_URI, clientId: TEST_CLIENT_ID },
        { clock, fetcher: issuer.fetcher },
      ),
    clients,
    settings,
  };
  const { app, api } = createApp(
    {
      ...auth,
      log: (error) => loggedErrors.push(error),
      identity,
      notifications,
      invoker,
      webOrigin: SPEC_WEB_ORIGIN,
    },
    options.extend ? { extend: options.extend } : {},
  );
  const fetch = inProcessFetch(app);

  async function call(method: string, path: string, opts: CallOptions = {}): Promise<CallResult> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.json !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${API_BASE_PATH}${path}`, {
      method,
      headers,
      ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
      ...(opts.rawBody !== undefined ? { body: opts.rawBody } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      headers: response.headers,
      body: text ? JSON.parse(text) : undefined,
    };
  }

  function token(sub: string, role: string, extra: { expiresInSeconds?: number } = {}): string {
    return issuer.accessToken({ sub, role, tenantId }, { issuedAt: clock.now(), ...extra });
  }

  async function seedClient(
    status: ClientStatus = 'enabled',
    fields: Partial<ClientRecord> = {},
  ): Promise<ClientRecord & { token: string }> {
    const clientId = ClientIdSchema.parse(randomUUID());
    const record: ClientRecordInput = {
      clientId,
      name: 'Giulia Bianchi',
      email: `${clientId}@example.test`,
      status,
      locale: 'it',
      createdAt: clock.now().toISOString(),
      ...fields,
    };
    await clients.put(tenantId, record);
    const stored = (await clients.get(tenantId, clientId)) as ClientRecord;
    return { ...stored, token: token(clientId, 'client') };
  }

  /** One tick of the delivery jobs at the clock's instant (§5.3), waiting for the notifier. */
  async function tick(): Promise<TickReport> {
    const report = await runTick(
      deliveryJobs(invoker),
      { tenantId, now: clock.now() },
      (event, details) => notifierLog.push([event, details]),
    );
    await invoker.settled();
    return report;
  }

  async function seedTherapist(): Promise<{ therapistId: string; token: string }> {
    await settings.create(tenantId, clock.now());
    const therapistId = randomUUID();
    return { therapistId, token: token(therapistId, 'therapist') };
  }

  return {
    app,
    api,
    clock,
    issuer,
    tenantId,
    clients,
    settings,
    notifications,
    markers,
    channel,
    notifier,
    notifierLog,
    invoker,
    identity,
    emulator,
    fetch,
    loggedErrors,
    call,
    token,
    seedClient,
    seedTherapist,
    tick,
  };
}

export type ApiHarness = ReturnType<typeof apiHarness>;
