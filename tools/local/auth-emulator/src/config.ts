import { DEFAULT_TENANT_ID } from '@fisio/contracts';

/**
 * The emulator's settings (docs/architecture.md §8.1, §11.4). Lifetimes mirror the Cognito pool:
 * 60-minute access and ID tokens, refresh tokens of 30 days for clients and 7 for the therapist.
 * The one-time code (8 digits, 5 minutes) and the lockout (5 wrong attempts → 15 minutes) are the
 * emulator's choice where Cognito publishes no exact figure.
 */
export interface EmulatorConfig {
  /** The `iss` claim; the HTTP server publishes the JWKS at `<issuer>/.well-known/jwks.json`. */
  readonly issuer: string;
  /** The SPA's app client id: the `client_id` of access tokens, the `aud` of ID tokens. */
  readonly clientId: string;
  /** The `tenantId` claim the pre-token-generation trigger adds in the cloud. */
  readonly tenantId: string;
  /** Partitions the emulator's items in the table; one per spec file. */
  readonly poolId: string;
  readonly otpDigits: number;
  /** The life of every sign-in step: the email code, the TOTP challenge and the TOTP enrolment. */
  readonly otpValiditySeconds: number;
  readonly maxFailedAttempts: number;
  readonly lockoutSeconds: number;
  readonly accessTokenSeconds: number;
  readonly refreshTokenDays: { readonly client: number; readonly therapist: number };
  /** How long a setup code from the bootstrap CLI stays usable (Cognito: temporary password). */
  readonly setupCodeDays: number;
}

export const MS_PER_DAY = 86_400_000;

/** The local SPA (Vite, WP0.7): the CORS origins, and the setup page of the bootstrap link. */
export const LOCAL_WEB_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];
export const LOCAL_SETUP_URL = 'http://127.0.0.1:5173/setup';

/** `pnpm dev`: the issuer `apps/api/src/runtime/local.ts` expects. */
export const LOCAL_EMULATOR_PORT = 9100;
export const LOCAL_POOL_ID = 'local';

export const DEFAULT_EMULATOR_CONFIG: EmulatorConfig = {
  issuer: `http://127.0.0.1:${LOCAL_EMULATOR_PORT}/${LOCAL_POOL_ID}`,
  clientId: 'fisio-local-web',
  tenantId: DEFAULT_TENANT_ID,
  poolId: LOCAL_POOL_ID,
  otpDigits: 8,
  otpValiditySeconds: 5 * 60,
  maxFailedAttempts: 5,
  lockoutSeconds: 15 * 60,
  accessTokenSeconds: 60 * 60,
  refreshTokenDays: { client: 30, therapist: 7 },
  setupCodeDays: 7,
};
