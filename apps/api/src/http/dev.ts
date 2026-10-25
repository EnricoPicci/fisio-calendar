import { IsoDateTimeSchema } from '@fisio/contracts';
import { z } from 'zod';
import { type AuthDeps, defineRoute } from './access';
import type { ApiRouter } from './router';

/**
 * `/__dev/*` (docs/architecture.md §5.2, §11.4): time travel for the local stack. Mounted only
 * by `runtime/local.ts`, which listens on 127.0.0.1; the Lambda runtime never registers them
 * (asserted by a runtime spec, and by the bundle smoke in WP0.9). Hidden from the OpenAPI
 * document, which describes the deployed API.
 */
export interface DevHooks {
  /** Runs the jobs handler's tick at `now` (WP0.6). */
  tick(now: Date): Promise<void>;
  /** Sweeps stale `sending` items, then delivers the due notifications, as the tick does (WP0.6). */
  deliver(): Promise<void>;
}

const AcceptedSchema = z.object({ accepted: z.literal(true) });

export function registerDevRoutes(api: ApiRouter, deps: AuthDeps, hooks: DevHooks): void {
  const accepted = {
    202: { description: 'Done', content: { 'application/json': { schema: AcceptedSchema } } },
  };

  const tick = defineRoute('public', deps, {
    method: 'post',
    path: '/__dev/tick',
    hide: true,
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: z.object({ now: IsoDateTimeSchema }).strict() } },
      },
    },
    responses: accepted,
  });
  api.openapi(tick, async (c) => {
    await hooks.tick(new Date(c.req.valid('json').now));
    return c.json({ accepted: true as const }, 202);
  });

  const deliver = defineRoute('public', deps, {
    method: 'post',
    path: '/__dev/deliver',
    hide: true,
    responses: accepted,
  });
  api.openapi(deliver, async (c) => {
    await hooks.deliver();
    return c.json({ accepted: true as const }, 202);
  });
}
