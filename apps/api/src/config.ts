import { DEFAULT_TENANT_ID, type TenantId, TenantIdSchema } from '@fisio/contracts';
import { z } from 'zod';

/**
 * The `Config` port (docs/architecture.md §4.1, §11.4): everything the Lambda code reads from its
 * environment, checked once at startup. The Lambda roots read the function's environment
 * variables (set by the CDK `App` stack); the local root reads `.env.local` over local defaults.
 * Nothing else reads `process.env`. Each function has its own loader: `api`
 * ({@link loadConfig}, plus {@link loadCloudApiConfig} in the cloud), `notifier`
 * ({@link loadNotifierConfig}) and `jobs` ({@link loadJobsConfig}).
 */
export interface Config extends TableConfig {
  readonly auth: AuthConfig;
  /** The SPA's origin, e.g. `https://fisio.example`: invitation links point there. */
  readonly webOrigin: string;
}

/** The table every function reads and writes. */
export interface TableConfig {
  readonly stage: Stage;
  readonly tableName: string;
  /** DynamoDB Local's URL; unset in the cloud, where the SDK resolves the regional endpoint. */
  readonly dynamoEndpoint?: string;
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
const optional = z.preprocess(blankAsUnset, z.string().trim().min(1).optional());
const optionalUrl = z.preprocess(blankAsUnset, z.url().optional());

const TableEnv = {
  STAGE: z.preprocess(blankAsUnset, z.enum(STAGES)),
  TABLE_NAME: required,
  DYNAMODB_ENDPOINT: optionalUrl,
};

const ApiEnvSchema = z.object({
  ...TableEnv,
  AUTH_ISSUER: z.preprocess(blankAsUnset, z.url()),
  AUTH_JWKS_URI: optionalUrl,
  AUTH_CLIENT_ID: required,
  WEB_ORIGIN: z.preprocess(
    blankAsUnset,
    z.url({ protocol: /^https?$/ }).transform((url) => new URL(url).origin),
  ),
});

/** Parses `env`, or throws a {@link ConfigError} naming the rejected variables. */
function parseEnv<S extends z.ZodType>(schema: S, env: Env): z.infer<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new ConfigError(`Missing or invalid environment variables: ${names.join(', ')}`);
  }
  return parsed.data;
}

/** `dev` and `prod`: deployed functions, where no local default may apply. */
function isCloudStage(stage: Stage): boolean {
  return stage === 'dev' || stage === 'prod';
}

function tableConfig(vars: {
  STAGE: Stage;
  TABLE_NAME: string;
  DYNAMODB_ENDPOINT?: string | undefined;
}): TableConfig {
  return {
    stage: vars.STAGE,
    tableName: vars.TABLE_NAME,
    ...(vars.DYNAMODB_ENDPOINT ? { dynamoEndpoint: vars.DYNAMODB_ENDPOINT } : {}),
  };
}

/**
 * The `api` function's configuration in `env`. `AUTH_JWKS_URI` defaults to the issuer's
 * `/.well-known/jwks.json`, where Cognito and the emulator publish their keys.
 */
export function loadConfig(env: Env): Config {
  const vars = parseEnv(ApiEnvSchema, env);
  // Plain http only on the laptop: invitation links in dev and prod point at CloudFront.
  if (isCloudStage(vars.STAGE) && !vars.WEB_ORIGIN.startsWith('https:')) {
    throw new ConfigError('Missing or invalid environment variables: WEB_ORIGIN');
  }
  return {
    ...tableConfig(vars),
    auth: {
      issuer: vars.AUTH_ISSUER,
      jwksUri:
        vars.AUTH_JWKS_URI ?? `${vars.AUTH_ISSUER.replace(/\/+$/, '')}/.well-known/jwks.json`,
      clientId: vars.AUTH_CLIENT_ID,
    },
    webOrigin: vars.WEB_ORIGIN,
  };
}

/**
 * What only the `api` Lambda needs on top of {@link Config}: the Cognito pool it administers and
 * the notifier function it invokes after a commit. The local runtime uses the emulator and an
 * in-process notifier instead.
 */
export interface CloudApiConfig extends Config {
  readonly userPoolId: string;
  readonly notifierFunctionName: string;
}

export function loadCloudApiConfig(env: Env): CloudApiConfig {
  const config = loadConfig(env);
  const vars = parseEnv(
    z.object({ USER_POOL_ID: required, NOTIFIER_FUNCTION_NAME: required }),
    env,
  );
  return {
    ...config,
    userPoolId: vars.USER_POOL_ID,
    notifierFunctionName: vars.NOTIFIER_FUNCTION_NAME,
  };
}

/** The `notifier` Lambda (§5.4): the table and the SES sender. */
export interface NotifierConfig extends TableConfig {
  readonly email: {
    readonly from: { readonly name: string; readonly address: string };
    /** The SES configuration set that publishes bounces and complaints (WP0.9, WP2.5). */
    readonly configurationSet?: string;
  };
}

export function loadNotifierConfig(env: Env): NotifierConfig {
  const vars = parseEnv(
    z.object({
      ...TableEnv,
      EMAIL_FROM_ADDRESS: z.preprocess(blankAsUnset, z.email()),
      EMAIL_FROM_NAME: optional,
      SES_CONFIGURATION_SET: optional,
    }),
    env,
  );
  return {
    ...tableConfig(vars),
    email: {
      from: { name: vars.EMAIL_FROM_NAME ?? 'Fisio Calendar', address: vars.EMAIL_FROM_ADDRESS },
      ...(vars.SES_CONFIGURATION_SET ? { configurationSet: vars.SES_CONFIGURATION_SET } : {}),
    },
  };
}

/**
 * The `jobs` Lambda (§5.3): the table, the tenant it ticks for, and the notifier it invokes.
 * `TENANT_ID` is required in `dev` and `prod`: a tick for the wrong tenant finds nothing and
 * reports success, so retries and recoveries would silently stop.
 */
export interface JobsConfig extends TableConfig {
  readonly tenantId: TenantId;
  readonly notifierFunctionName: string;
}

export function loadJobsConfig(env: Env): JobsConfig {
  const vars = parseEnv(
    z.object({
      ...TableEnv,
      TENANT_ID: z.preprocess(blankAsUnset, TenantIdSchema.optional()),
      NOTIFIER_FUNCTION_NAME: required,
    }),
    env,
  );
  if (isCloudStage(vars.STAGE) && vars.TENANT_ID === undefined) {
    throw new ConfigError('Missing or invalid environment variables: TENANT_ID');
  }
  return {
    ...tableConfig(vars),
    tenantId: vars.TENANT_ID ?? TenantIdSchema.parse(DEFAULT_TENANT_ID),
    notifierFunctionName: vars.NOTIFIER_FUNCTION_NAME,
  };
}
