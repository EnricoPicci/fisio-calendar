import { HealthResponseSchema } from '@fisio/contracts';
import { type AuthDeps, defineRoute } from '../access';
import type { ApiRouter } from '../router';

/** `GET /health`: liveness, no token, no database read. */
export function registerHealth(api: ApiRouter, deps: AuthDeps): void {
  const route = defineRoute('public', deps, {
    method: 'get',
    path: '/health',
    summary: 'Liveness',
    responses: {
      200: {
        description: 'The API is up',
        content: { 'application/json': { schema: HealthResponseSchema } },
      },
    },
  });
  api.openapi(route, (c) => c.json({ status: 'ok' as const }, 200));
}
