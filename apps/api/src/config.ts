import { z } from 'zod';

/**
 * The `Config` port (docs/architecture.md §4.1, §11.4): everything the API reads from its
 * environment, checked once at startup. The Lambda root reads the function's environment
 * variables (set by the CDK `App` stack); the local root reads `.env.local` over local defaults.
 * Nothing else reads `process.env`.
 */
export interface Config {
  readonly stage: Stage;
  readonly tableName: string;
  /** DynamoDB Local's URL; unset in the cloud, where the SDK resolves the regional endpoint. */
  readonly dynamoEndpoint?: string;
  readonly auth: AuthConfig;
}

/** Whose tokens the API accepts: Cognito's in the cloud, the auth emulator's locally. */
export interface AuthConfig {
  /** The `iss` claim, e.g. `https://cognito-idp.eu-central-1.amazonaws.com/<poolId>`. */
  readonly issuer: string;
  readonly jwksUri: string;
  /** The SPA's app client id, the `client_id` claim of its access tokens. */
  readonly clientId: string;
}

export const STAGES = ['local', 'test', 'dev', 'prod'] as const;
export type Stage = (typeof STAGES)[number];

export type Env = Readonly<Record<string, string | undefined>>;

/** A missing or malformed variable; the message names variables, never their values. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const blankAsUnset = (value: unknown) => (value === '' ? undefined : value);
const required = z.preprocess(blankAsUnset, z.string().trim().min(1));
const optionalUrl = z.preprocess(blankAsUnset, z.url().optional());

const EnvSchema = z.object({
  STAGE: z.preprocess(blankAsUnset, z.enum(STAGES)),
  TABLE_NAME: required,
  DYNAMODB_ENDPOINT: optionalUrl,
  AUTH_ISSUER: z.preprocess(blankAsUnset, z.url()),
  AUTH_JWKS_URI: optionalUrl,
  AUTH_CLIENT_ID: required,
});

/**
 * The configuration in `env`. `AUTH_JWKS_URI` defaults to the issuer's
 * `/.well-known/jwks.json`, where Cognito and the emulator publish their keys.
 */
export function loadConfig(env: Env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new ConfigError(`Missing or invalid environment variables: ${names.join(', ')}`);
  }
  const vars = parsed.data;
  return {
    stage: vars.STAGE,
    tableName: vars.TABLE_NAME,
    ...(vars.DYNAMODB_ENDPOINT ? { dynamoEndpoint: vars.DYNAMODB_ENDPOINT } : {}),
    auth: {
      issuer: vars.AUTH_ISSUER,
      jwksUri:
        vars.AUTH_JWKS_URI ?? `${vars.AUTH_ISSUER.replace(/\/+$/, '')}/.well-known/jwks.json`,
      clientId: vars.AUTH_CLIENT_ID,
    },
  };
}
