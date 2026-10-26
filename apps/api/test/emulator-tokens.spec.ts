import { DEFAULT_EMULATOR_CONFIG } from '@fisio/auth-emulator';
import { otpCodeIn } from '@fisio/auth-emulator/testing';
import { ClientIdSchema } from '@fisio/contracts';
import { closeTestDocumentClient } from '@fisio/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_DEFAULTS } from '../src/runtime/local';
import { apiHarness, emulatorTokens } from './harness';

/**
 * The local stack's tokens: the API verifies the auth emulator's tokens with the same verifier
 * it uses for Cognito's (docs/architecture.md §11.4), only the issuer differs.
 */
const h = apiHarness({ tokens: emulatorTokens });
afterAll(closeTestDocumentClient);
const { channel } = h;

describe('Local stack: the API accepts the auth emulator tokens', () => {
  // Value: protects=a client signed in through the emulator reaches the API as that client; fails_when=a claim the verifier needs (token_use, client_id, role, tenantId, sub) is missing or shaped unlike Cognito's; why_new=first emulator; seam=JWKS served from memory; no_claim=Cognito's tokens (dev smoke, WP0.10)
  it('a client signed in with the one-time code calls GET /me', async () => {
    const user = await h.emulator.identity.createUser({
      email: 'giulia@example.test',
      role: 'client',
    });
    await h.seedClient('enabled', {
      clientId: ClientIdSchema.parse(user.userId),
      email: user.email,
    });
    const step = await h.emulator.emulator.startEmailOtp(user.email);
    if (step.kind !== 'challenge') throw new Error('Expected a challenge');
    const tokens = await h.emulator.emulator.answerEmailOtp(
      step.session,
      otpCodeIn(channel.sentTo(user.email).at(-1)),
    );

    const me = await h.call('GET', '/me', { token: tokens.accessToken });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: 'client', clientId: user.userId });
    // The ID token is not an access token: refused.
    expect((await h.call('GET', '/me', { token: tokens.idToken })).status).toBe(401);
  });

  // Value: protects=the therapist signed in with password + TOTP reaches the API as the therapist; fails_when=the therapist token lacks the role or tenant the API checks; why_new=first emulator; seam=JWKS from memory; no_claim=admin routes (later WPs)
  it('the therapist signed in with password and TOTP calls GET /me', async () => {
    await h.settings.create(h.tenantId, h.clock.now());
    const user = await h.emulator.identity.createUser({
      email: 'terapista@example.test',
      role: 'therapist',
    });
    await h.emulator.identity.setTotpPreference(user.userId, { enabled: true, preferred: true });
    const { tokens } = await h.emulator.completeSetup(
      await h.emulator.identity.startPasswordSetup(user.userId),
      'una-password-lunga',
    );

    const me = await h.call('GET', '/me', { token: tokens.accessToken });
    expect(me.body).toEqual({ role: 'therapist', therapistId: user.userId });
  });

  // Value: protects=`pnpm dev`'s API trusts the issuer and client id the emulator signs with; fails_when=the emulator's port, pool id or client id changes on one side only; why_new=the two values are copied across packages; seam=none; no_claim=a running `pnpm dev`
  it('the local API expects the issuer and client id of the local emulator', () => {
    expect([LOCAL_DEFAULTS.AUTH_ISSUER, LOCAL_DEFAULTS.AUTH_CLIENT_ID]).toEqual([
      DEFAULT_EMULATOR_CONFIG.issuer,
      DEFAULT_EMULATOR_CONFIG.clientId,
    ]);
  });
});
