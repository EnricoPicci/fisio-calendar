import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Problem, TenantIdSchema } from '@fisio/contracts';
import { FixedClock } from '@fisio/domain';
import {
  closeTestDocumentClient,
  freshTenant,
  TEST_TABLE,
  TestTokenIssuer,
  testDocumentClient,
} from '@fisio/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { API_BASE_PATH } from '../src/http/app';
import type { DevHooks } from '../src/http/dev';
import { SettingsRepository } from '../src/repo/settings';
import { createLambdaApp } from '../src/runtime/lambda';
import { createLocalApp } from '../src/runtime/local';

afterAll(closeTestDocumentClient);

/**
 * The two composition roots (architecture §5.1, §11.4), built with their real adapters. Only
 * the last spec reaches DynamoDB Local and a JWKS, served over plain HTTP on 127.0.0.1.
 */
const lambdaEnv = {
  STAGE: 'dev',
  TABLE_NAME: 'fisio-dev',
  AUTH_ISSUER: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_example',
  AUTH_CLIENT_ID: 'example-client',
  AWS_REGION: 'eu-central-1',
};

const post = (path: string, body?: unknown) =>
  new Request(`http://localhost${API_BASE_PATH}${path}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

describe('F Contracts and local stack: local /__dev/tick and /__dev/deliver exist in the local runtime only', () => {
  // Value: protects=time travel cannot be reached in the cloud; fails_when=lambda.ts mounts the dev routes or createApp registers them itself; why_new=first runtimes; seam=none; no_claim=the bundled artifact (bundle smoke, WP0.9)
  it('/__dev/tick returns 404 in the Lambda runtime', async () => {
    const { app } = createLambdaApp(lambdaEnv);
    for (const path of ['/__dev/tick', '/__dev/deliver']) {
      const res = await app.request(post(path, { now: '2027-03-01T08:00:00.000Z' }));
      expect(res.status, path).toBe(404);
      expect(((await res.json()) as Problem).code, path).toBe('not_found');
    }
  });

  // Value: protects=the local runtime runs the tick at the instant asked for, and validates it; fails_when=the dev routes are missing locally, ignore `now`, or accept a malformed instant; why_new=first runtimes; seam=recording DevHooks; no_claim=what the tick does (WP0.6)
  it('the local runtime runs the tick at the given instant and delivers on request', async () => {
    const calls: string[] = [];
    const hooks: DevHooks = {
      tick: async (now) => {
        calls.push(`tick ${now.toISOString()}`);
      },
      deliver: async () => {
        calls.push('deliver');
      },
    };
    const { app } = createLocalApp(
      {},
      { clock: new FixedClock('2027-03-01T08:00:00Z'), devHooks: hooks },
    );
    expect(
      (await app.request(post('/__dev/tick', { now: '2027-03-28T01:00:00.000Z' }))).status,
    ).toBe(202);
    expect((await app.request(post('/__dev/deliver'))).status).toBe(202);
    const bad = await app.request(post('/__dev/tick', { now: 'tomorrow' }));
    expect(bad.status).toBe(400);
    const problem = (await bad.json()) as Problem;
    expect(problem.code).toBe('validation_failed');
    expect(problem.errors).toContainEqual({ in: 'body', path: ['now'], code: 'invalid_format' });
    expect(calls).toEqual(['tick 2027-03-28T01:00:00.000Z', 'deliver']);
  });

  // Value: protects=both runtimes serve the same API; fails_when=a root forgets a route or the base path; why_new=first runtimes; seam=none; no_claim=Function URL event translation (bundle smoke, WP0.9)
  it('both runtimes answer GET /health', async () => {
    // The Lambda root always takes the system clock; /health reads no time, so this stays stable.
    const clock = new FixedClock('2027-03-01T08:00:00.000Z');
    for (const { app } of [createLambdaApp(lambdaEnv), createLocalApp({}, { clock })]) {
      const res = await app.request(`${API_BASE_PATH}/health`);
      expect(res.status).toBe(200);
    }
  });
});

describe('F Contracts and local stack: the local runtime verifies tokens against a plain-HTTP JWKS (architecture §11.4)', () => {
  // Value: protects=the local stack accepts the emulator's tokens, whose JWKS is served over http://127.0.0.1; fails_when=local.ts drops the fetchJwks fetcher (aws-jwt-verify's own fetcher speaks HTTPS only, so every local call answers 500) or derives the JWKS URI from another path; why_new=the runtime specs above never reach a JWKS, and the API harness injects an in-memory fetcher; seam=a node:http server on 127.0.0.1 standing in for the auth emulator (WP0.5); no_claim=the emulator's own key publication and its port
  it('a therapist token signed by a key published over http://127.0.0.1 opens GET /me', async () => {
    let issuer: TestTokenIssuer | undefined;
    const requested: string[] = [];
    const server = createServer((req, res) => {
      requested.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(issuer?.jwks));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      issuer = new TestTokenIssuer({ issuer: `http://127.0.0.1:${port}/local` });
      const clock = new FixedClock('2027-03-01T08:00:00.000Z');
      const tenantId = TenantIdSchema.parse(freshTenant());
      await new SettingsRepository(testDocumentClient(), TEST_TABLE).create(tenantId, clock.now());
      const { app } = createLocalApp(
        {
          AUTH_ISSUER: issuer.issuer,
          AUTH_CLIENT_ID: issuer.clientId,
          TABLE_NAME: TEST_TABLE,
          DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT,
        },
        { clock },
      );
      const therapistId = crypto.randomUUID();
      const token = issuer.accessToken(
        { sub: therapistId, role: 'therapist', tenantId },
        { issuedAt: clock.now() },
      );
      const res = await app.request(`${API_BASE_PATH}/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ role: 'therapist', therapistId });
      expect(requested).toEqual(['/local/.well-known/jwks.json']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
