import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Clock, NotificationChannel, OutboundMessage } from '@fisio/domain';
import { generate } from 'otplib';
import { DEFAULT_EMULATOR_CONFIG, type EmulatorConfig } from './config';
import { AuthEmulator, type AuthTokens } from './emulator';
import { LocalIdentityProvider } from './identity-provider';
import { RsaSigner } from './jwt';
import { EmulatorStore } from './store';

/**
 * The emulator assembled for specs and tools (`@fisio/auth-emulator/testing`): a pool of its own
 * in the given table, the given clock and channel. It takes its collaborators instead of
 * importing the testkit, which may later depend on this package (journeys, WP0.8).
 */
export interface TestEmulatorOptions {
  readonly doc: DynamoDBDocumentClient;
  readonly table: string;
  readonly clock: Clock;
  readonly channel: NotificationChannel;
  readonly config: Partial<EmulatorConfig> & Pick<EmulatorConfig, 'poolId' | 'tenantId'>;
}

export function createTestEmulator(options: TestEmulatorOptions) {
  const config: EmulatorConfig = { ...DEFAULT_EMULATOR_CONFIG, ...options.config };
  const store = new EmulatorStore(options.doc, options.table, config.poolId);
  const signer = new RsaSigner();
  const emulator = new AuthEmulator({
    store,
    signer,
    channel: options.channel,
    clock: options.clock,
    config,
  });
  const identity = new LocalIdentityProvider(store, options.clock, config);

  /** The current TOTP code for `secret` at the emulator's clock. */
  const totp = (secret: string) => totpCode(options.clock, secret);

  return {
    config,
    store,
    signer,
    emulator,
    identity,
    totp,
    completeSetup: (setupCode: string, password: string) =>
      completeSetup(emulator, options.clock, setupCode, password),
  };
}

/** The TOTP code for `secret` at `clock`'s instant. */
export function totpCode(clock: Clock, secret: string): Promise<string> {
  return generate({ secret, epoch: Math.floor(clock.now().getTime() / 1000) });
}

/** Uses a setup code as the therapist would: password, then the first TOTP code. */
export async function completeSetup(
  emulator: AuthEmulator,
  clock: Clock,
  setupCode: string,
  password: string,
): Promise<{ secret: string; otpauthUri: string; tokens: AuthTokens }> {
  const enrolment = await emulator.startSetup(setupCode, password);
  const code = await totpCode(clock, enrolment.secret);
  const tokens = await emulator.verifyTotpSetup(enrolment.session, code);
  return { secret: enrolment.secret, otpauthUri: enrolment.otpauthUri, tokens };
}

export type TestEmulator = ReturnType<typeof createTestEmulator>;

/** The one-time code in an emulator OTP email. */
export function otpCodeIn(message: OutboundMessage | undefined): string {
  const code = /\b(\d{6,10})\b/.exec(message?.text ?? '')?.[1];
  if (!code) throw new Error('No one-time code in the message');
  return code;
}

/** The payload of a JWT, unverified: for asserting claims in specs. */
export function jwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
}
