import { closeTestDocumentClient } from '@fisio/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createEmulatorApp } from '../src/server';
import { emulatorHarness, THERAPIST_PASSWORD } from './harness';

const h = emulatorHarness();
afterAll(closeTestDocumentClient);
const app = createEmulatorApp(h.emulator, h.config);
const base = new URL(h.config.issuer).pathname;

async function post(path: string, body: unknown) {
  const res = await app.request(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // biome-ignore lint/suspicious/noExplicitAny: specs read response bodies freely.
  const answer: any = await res.json();
  return { status: res.status, body: answer };
}

describe('Auth emulator over HTTP (pnpm dev, architecture §11.4)', () => {
  // Value: protects=the API's verifier finds the emulator's keys where it looks for Cognito's; fails_when=the JWKS moves off <issuer>/.well-known/jwks.json or loses its fields; why_new=first server; seam=app.request; no_claim=that the API accepts the tokens (apps/api emulator-tokens spec)
  it('publishes its JWKS at <issuer>/.well-known/jwks.json', async () => {
    const res = await app.request(`${base}/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      keys: [expect.objectContaining({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: h.signer.kid })],
    });
  });

  // Value: protects=the SPA's LocalAuthService can run the code flow over HTTP and read refusals as codes; fails_when=a route is missing, a refusal is not 400 {code}, or a bad body crashes; why_new=first server; seam=FakeChannel; no_claim=CORS in a real browser (Playwright, WP0.8)
  it('runs the code flow and answers a refusal with 400 and only its code', async () => {
    const user = await h.client();
    const started = await post('/email-otp', { email: user.email });
    expect(started.body).toMatchObject({ kind: 'challenge', challenge: 'EMAIL_OTP' });

    const wrong = await post('/email-otp/answer', {
      session: started.body.session,
      code: h.wrongCode(user.email),
    });
    expect(wrong).toEqual({ status: 400, body: { code: 'code_mismatch' } });

    const signedIn = await post('/email-otp/answer', {
      session: started.body.session,
      code: h.lastCode(user.email),
    });
    expect(signedIn.status).toBe(200);
    const refreshed = await post('/refresh', { refreshToken: signedIn.body.refreshToken });
    expect(refreshed.body).toHaveProperty('accessToken');

    expect(await post('/email-otp', { email: user.email, extra: 1 })).toEqual({
      status: 400,
      body: { code: 'validation_failed' },
    });
    // A session id longer than any the emulator issues never reaches the store's key.
    expect(
      await post('/email-otp/answer', { session: 'x'.repeat(2048), code: '12345678' }),
    ).toEqual({ status: 400, body: { code: 'validation_failed' } });
  });

  // Value: protects=a page on another site cannot send codes or lock seeded accounts through the developer's browser; fails_when=a foreign origin or a text/plain "simple" POST reaches a handler; why_new=red-team finding (WP0.5); seam=FakeChannel; no_claim=browser local-network protections
  it('refuses a foreign browser origin and a POST that is not JSON, before any handler runs', async () => {
    const user = await h.client();
    const sent = h.channel.sentTo(user.email).length;
    const attempt = (headers: Record<string, string>) =>
      app.request(`${base}/email-otp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: user.email }),
      });
    const foreign = await attempt({
      origin: 'https://evil.example',
      'content-type': 'application/json',
    });
    expect([foreign.status, await foreign.json()]).toEqual([403, { code: 'forbidden_origin' }]);
    const plain = await attempt({ 'content-type': 'text/plain' });
    expect([plain.status, await plain.json()]).toEqual([400, { code: 'validation_failed' }]);
    expect(h.channel.sentTo(user.email)).toHaveLength(sent);

    const local = await attempt({
      origin: 'http://127.0.0.1:5173',
      'content-type': 'application/json',
    });
    expect(local.status).toBe(200);
  });

  // Value: protects=the SPA's therapist setup and password + TOTP sign-in reach their handlers over HTTP, and odd requests get their codes; fails_when=a therapist route is missing or miswired, an unknown path is not 404 not_found, or malformed JSON is a 500; why_new=only the code flow is specced over HTTP; seam=app.request; no_claim=CORS in a real browser (Playwright, WP0.8)
  it('runs the setup link and the password + TOTP sign-in; an unknown path or malformed JSON gets its code', async () => {
    const user = await h.identity.createUser({
      email: 'http-terapista@example.test',
      role: 'therapist',
    });
    await h.identity.setTotpPreference(user.userId, { enabled: true, preferred: true });
    const setup = await post('/setup', {
      code: await h.identity.startPasswordSetup(user.userId),
      password: THERAPIST_PASSWORD,
    });
    expect(setup.status).toBe(200);
    const verified = await post('/setup/verify', {
      session: setup.body.session,
      code: await h.totp(setup.body.secret),
    });
    expect(verified.body).toHaveProperty('accessToken');

    h.clock.advance({ seconds: 30 });
    const password = await post('/password', { email: user.email, password: THERAPIST_PASSWORD });
    expect(password.body).toMatchObject({ kind: 'challenge', challenge: 'SOFTWARE_TOKEN_MFA' });
    const signedIn = await post('/totp/answer', {
      session: password.body.session,
      code: await h.totp(setup.body.secret),
    });
    expect(signedIn.body).toHaveProperty('accessToken');

    expect(await post('/nowhere', {})).toEqual({ status: 404, body: { code: 'not_found' } });
    const malformed = await app.request(`${base}/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect([malformed.status, await malformed.json()]).toEqual([
      400,
      { code: 'validation_failed' },
    ]);
  });

  // Value: protects=a failure that is not a sign-in refusal answers 500 internal_error with nothing else, so LocalAuthService treats it as unexpected; fails_when=onError answers it as a 400 refusal, reads a stored record's schema failure as a bad request body, or puts the error's text or stack in the body; why_new=only refusals, bad bodies and unknown paths are specced; seam=a stub emulator through createEmulatorApp's parameter; no_claim=what the console logs
  it('an unexpected failure answers 500 with only the internal_error code', async () => {
    const failing = Object.create(h.emulator, {
      startEmailOtp: {
        value: async () => {
          throw new Error('DynamoDB Local unreachable at 127.0.0.1:8000');
        },
      },
    });
    const broken = createEmulatorApp(failing, h.config);
    const res = await broken.request(`${base}/email-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'giulia@example.test' }),
    });
    expect([res.status, await res.json()]).toEqual([500, { code: 'internal_error' }]);

    // A stored record that fails its schema is the emulator's fault, not a malformed request.
    const corrupt = Object.create(h.emulator, {
      startEmailOtp: {
        value: async () => z.object({ passwordHash: z.string() }).parse({ passwordHash: 7 }),
      },
    });
    const stale = await createEmulatorApp(corrupt, h.config).request(`${base}/email-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'giulia@example.test' }),
    });
    expect([stale.status, await stale.json()]).toEqual([500, { code: 'internal_error' }]);
  });
});
