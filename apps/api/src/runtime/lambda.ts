import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { systemClock } from '@fisio/domain';
import { type Env, loadConfig } from '../config';
import { type ApiApp, createApp } from '../http/app';
import { consoleErrorLogger } from '../http/router';
import { createTokenVerifier } from '../identity/token-verifier';
import { ClientRepository } from '../repo/clients';
import { SettingsRepository } from '../repo/settings';

/**
 * Composition root for the `api` Lambda (docs/architecture.md §4.3): AWS adapters, the system
 * clock, Cognito's JWKS over HTTPS. Never mounts `/__dev/*`. The environment comes from the CDK
 * `App` stack (WP0.9).
 */
export function createLambdaApp(env: Env): ApiApp {
  const config = loadConfig(env);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return createApp({
    clock: systemClock,
    log: consoleErrorLogger,
    tokens: createTokenVerifier(config.auth, { clock: systemClock }),
    clients: new ClientRepository(doc, config.tableName),
    settings: new SettingsRepository(doc, config.tableName),
  });
}
