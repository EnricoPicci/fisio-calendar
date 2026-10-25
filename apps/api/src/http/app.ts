import { type Clock, localDateTimeToUtc, THERAPIST_TIME_ZONE } from '@fisio/domain';
import { Hono } from 'hono';
import type { AddClientDeps } from '../usecases/add-client';
import type { ApiEnv, AuthDeps } from './access';
import { type ApiRouter, type ErrorLogger, installProblemHandling, newApiRouter } from './router';
import { registerAdminClients } from './routes/admin-clients';
import { registerHealth } from './routes/health';
import { registerMe } from './routes/me';

/**
 * The Hono app (docs/architecture.md §5.2), built from its ports by a composition root:
 * `runtime/lambda.ts` (AWS adapters) or `runtime/local.ts` (local adapters and `/__dev/*`).
 * Specs build it with the testkit doubles and call it in-process with `app.request()`.
 */
export const API_BASE_PATH = '/api/v1';

export interface AppDeps extends AuthDeps, AddClientDeps {
  readonly clock: Clock;
  readonly log: ErrorLogger;
}

export interface AppOptions {
  /** Registers further routes on the API router: the local `/__dev/*` routes, spec routes. */
  readonly extend?: (api: ApiRouter, deps: AppDeps) => void;
}

export interface ApiApp {
  /** The whole HTTP surface; the API is mounted at {@link API_BASE_PATH}. */
  readonly app: Hono<ApiEnv>;
  /** The API router, whose registry generates `docs/openapi.json`. */
  readonly api: ApiRouter;
}

export function createApp(deps: AppDeps, options: AppOptions = {}): ApiApp {
  assertTimeZoneData();
  const api = newApiRouter(deps.log);
  registerHealth(api, deps);
  registerMe(api, deps);
  registerAdminClients(api, deps);
  options.extend?.(api, deps);

  api.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'A Cognito access token of the SPA app client',
  });

  const app = installProblemHandling(new Hono<ApiEnv>(), deps.log);
  app.route(API_BASE_PATH, api);
  return { app, api };
}

export function openApiDocument(api: ApiRouter) {
  return api.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'Fisio Calendar API',
      version: '1',
      description:
        'Generated from the route declarations in apps/api (`pnpm openapi`). Errors are RFC 9457 problem+json with `type` `urn:fisio:error:<code>`.',
    },
    servers: [{ url: API_BASE_PATH }],
  });
}

/**
 * Refuses to start on a runtime without Europe/Rome tz data (a Node build without full ICU):
 * every slot id check would fail there, so fail loudly at cold start instead.
 */
function assertTimeZoneData(): void {
  localDateTimeToUtc('2027-01-01', '00:00', THERAPIST_TIME_ZONE);
}
