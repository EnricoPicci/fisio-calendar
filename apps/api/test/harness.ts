import { randomUUID } from 'node:crypto';
import { ClientIdSchema, type ClientStatus, type TenantId, TenantIdSchema } from '@fisio/contracts';
import { FixedClock } from '@fisio/domain';
import {
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
import { createTokenVerifier } from '../src/identity/token-verifier';
import { type ClientRecord, ClientRepository } from '../src/repo/clients';
import { SettingsRepository } from '../src/repo/settings';

/**
 * The API spec harness (docs/architecture.md §10.1): the real app in-process (`app.request`) on
 * DynamoDB Local under a fresh tenant, at a fixed clock, with the real token verifier reading
 * the testkit issuer's JWKS from memory.
 */
export const SPEC_NOW = '2027-03-01T08:00:00.000Z';

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
  // biome-ignore lint/suspicious/noExplicitAny: specs read response bodies freely.
  readonly body: any;
}

export function apiHarness(options: AppOptions & { issuer?: TestTokenIssuer } = {}) {
  const clock = new FixedClock(SPEC_NOW);
  const issuer = options.issuer ?? new TestTokenIssuer();
  const doc = testDocumentClient();
  const tenantId: TenantId = TenantIdSchema.parse(freshTenant());
  const clients = new ClientRepository(doc, TEST_TABLE);
  const settings = new SettingsRepository(doc, TEST_TABLE);
  const loggedErrors: unknown[] = [];
  const auth: AuthDeps = {
    tokens: createTokenVerifier(
      { issuer: TEST_ISSUER, jwksUri: TEST_JWKS_URI, clientId: TEST_CLIENT_ID },
      { clock, fetcher: issuer.fetcher },
    ),
    clients,
    settings,
  };
  const { app, api } = createApp(
    { ...auth, clock, log: (error) => loggedErrors.push(error) },
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
    const record: ClientRecord = {
      clientId,
      name: 'Giulia Bianchi',
      email: `${clientId}@example.test`,
      status,
      locale: 'it',
      createdAt: clock.now().toISOString(),
      ...fields,
    };
    await clients.put(tenantId, record);
    return { ...record, token: token(clientId, 'client') };
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
    loggedErrors,
    call,
    token,
    seedClient,
    seedTherapist,
  };
}

export type ApiHarness = ReturnType<typeof apiHarness>;
