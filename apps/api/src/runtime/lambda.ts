import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { type AsyncHandler, systemClock } from '@fisio/domain';
import { type Env, loadCloudApiConfig, loadJobsConfig, loadNotifierConfig } from '../config';
import { type ApiApp, createApp } from '../http/app';
import { consoleErrorLogger } from '../http/router';
import { CognitoIdentityProvider } from '../identity/cognito-identity-provider';
import { createTokenVerifier } from '../identity/token-verifier';
import { consoleTickLog, createJobsHandler, deliveryJobs } from '../jobs/tick';
import { consoleNotifierLog, createNotifierHandler, Notifier } from '../notify/notifier';
import { SesEmailChannel } from '../notify/ses-email-channel';
import { ClientRepository } from '../repo/clients';
import { NotificationRepository } from '../repo/notifications';
import { SettingsRepository } from '../repo/settings';
import { LambdaAsyncInvoker } from './lambda-async-invoker';

/**
 * Composition roots of the Lambda functions (docs/architecture.md §4.3): AWS adapters and the
 * system clock. The environment comes from the CDK `App` stack (WP0.9). `api` never mounts
 * `/__dev/*`.
 */
function documentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient(SDK_CLIENT_CONFIG), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/**
 * Every AWS SDK client gives up on a request that hangs: without a timeout a stalled SES send
 * could outlive the sweep's 10-minute window and the email would go out twice (§5.4). The SDK's
 * own retries still apply to each attempt, except for SES: see {@link SES_CLIENT_CONFIG}.
 * `throwOnRequestTimeout`: without it the SDK only logs a warning when `requestTimeout` passes.
 */
export const SDK_CLIENT_CONFIG = {
  requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000, throwOnRequestTimeout: true },
} as const;

/**
 * SendEmail is not idempotent: an SDK retry after a timeout SES had in fact accepted sends the
 * email again. One attempt per call, so the notifier's back-off is the only retry and each
 * attempt is recorded on the item.
 */
const SES_CLIENT_CONFIG = { ...SDK_CLIENT_CONFIG, maxAttempts: 1 } as const;

/** The `api` function: Cognito's JWKS over HTTPS, the Cognito pool, async invokes of `notifier`. */
export function createLambdaApp(env: Env): ApiApp {
  const config = loadCloudApiConfig(env);
  const doc = documentClient();
  return createApp({
    clock: systemClock,
    log: consoleErrorLogger,
    tokens: createTokenVerifier(config.auth, { clock: systemClock }),
    clients: new ClientRepository(doc, config.tableName),
    settings: new SettingsRepository(doc, config.tableName),
    identity: new CognitoIdentityProvider(
      new CognitoIdentityProviderClient(SDK_CLIENT_CONFIG),
      config.userPoolId,
    ),
    notifications: new NotificationRepository(doc, config.tableName),
    invoker: new LambdaAsyncInvoker(new LambdaClient(SDK_CLIENT_CONFIG), {
      notifier: config.notifierFunctionName,
    }),
    webOrigin: config.webOrigin,
  });
}

/** The `notifier` function: delivery through SES. */
export function createLambdaNotifier(env: Env): AsyncHandler {
  const config = loadNotifierConfig(env);
  const notifier = new Notifier({
    notifications: new NotificationRepository(documentClient(), config.tableName),
    channels: { email: new SesEmailChannel(new SESv2Client(SES_CLIENT_CONFIG), config.email) },
    clock: systemClock,
    log: consoleNotifierLog,
  });
  return createNotifierHandler(notifier, consoleNotifierLog);
}

/** The `jobs` function: the 15-minute tick, which invokes `notifier` for sweep and deliver-due. */
export function createLambdaJobs(env: Env): AsyncHandler {
  const config = loadJobsConfig(env);
  const invoker = new LambdaAsyncInvoker(new LambdaClient(SDK_CLIENT_CONFIG), {
    notifier: config.notifierFunctionName,
  });
  return createJobsHandler({
    jobs: deliveryJobs(invoker),
    tenantId: config.tenantId,
    clock: systemClock,
    log: consoleTickLog,
  });
}
