import { IsoDateSchema, LocalTimeSchema, SlotIdSchema } from '@fisio/contracts';
import { InvalidTimeZoneError, localDateTimeToUtc, SlotId } from '@fisio/domain';
import { z } from 'zod';
import { defineRoute } from '../src/http/access';
import type { AppDeps } from '../src/http/app';
import type { ApiRouter } from '../src/http/router';

/**
 * Routes that exist only in specs, registered through `createApp`'s `extend` option: a
 * therapist-only route and a validated route before any real ones exist (WP1.x), and routes
 * that throw chosen errors to exercise the error mapper.
 */
export function registerSpecRoutes(api: ApiRouter, deps: AppDeps): void {
  const ok = {
    200: { description: 'ok', content: { 'application/json': { schema: z.object({}).loose() } } },
  };

  api.openapi(
    defineRoute('therapist', deps, { method: 'get', path: '/spec/therapist-only', responses: ok }),
    (c) => c.json({}, 200),
  );

  api.openapi(
    defineRoute('member', deps, {
      method: 'post',
      path: '/spec/validated/{slotId}',
      request: {
        params: z.object({ slotId: SlotIdSchema }),
        query: z.object({ from: IsoDateSchema }),
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z
                .object({ start: LocalTimeSchema, places: z.number().int().min(1) })
                .strict(),
            },
          },
        },
      },
      responses: ok,
    }),
    (c) => c.json({ slotId: c.req.valid('param').slotId }, 200),
  );

  const throwing = (path: string, error: () => unknown) =>
    api.openapi(defineRoute('public', deps, { method: 'get', path, responses: ok }), () => {
      throw error();
    });
  throwing('/spec/throw/dst-gap', () => {
    localDateTimeToUtc('2027-03-28', '02:30');
  });
  throwing('/spec/throw/bad-slot-id', () => SlotId.parse('tomorrow#pool'));
  throwing('/spec/throw/bad-local-date', () => {
    localDateTimeToUtc('2027-02-30', '09:00');
  });
  // The same error as a second copy of @fisio/domain would throw it: equal name, other class.
  throwing('/spec/throw/foreign-domain-error', () =>
    Object.assign(new RangeError('gap'), { name: 'NonexistentLocalTimeError' }),
  );
  throwing('/spec/throw/time-zone', () => new InvalidTimeZoneError('Europe/Rme'));
  throwing('/spec/throw/unexpected', () => new Error('secret table fisio-prod, item T#123'));
}
