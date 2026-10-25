import { closeTestDocumentClient } from '@fisio/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_LEVELS, type Access } from '../src/http/access';
import { API_BASE_PATH } from '../src/http/app';
import { type ApiHarness, apiHarness } from './harness';
import { registerSpecRoutes } from './spec-routes';

afterAll(closeTestDocumentClient);

interface DeclaredRoute {
  readonly method: string;
  readonly path: string;
  readonly access: Access;
  readonly hasBody: boolean;
}

/** The routes as declared to the OpenAPI registry: what `defineRoute` recorded. */
function declaredRoutes(h: ApiHarness): DeclaredRoute[] {
  return h.api.openAPIRegistry.definitions.flatMap((definition) => {
    if (definition.type !== 'route') return [];
    const route = definition.route as typeof definition.route & { 'x-access'?: Access };
    return [
      {
        method: route.method.toUpperCase(),
        path: route.path,
        access: route['x-access'] as Access,
        hasBody: route.request?.body !== undefined,
      },
    ];
  });
}

/** `/me/bookings/{bookingId}` → a request path with a placeholder value. */
const requestPath = (path: string) => path.replaceAll(/\{[^}]+\}/g, 'x');
const label = (route: DeclaredRoute) => `${route.method} ${route.path} (${route.access})`;

// The matrix runs over the deployed API's routes, and again with the spec-only routes, so every
// branch (therapist-only, validated body) is exercised before real routes of that kind exist.
describe.each([
  { name: 'registered routes', extend: undefined },
  { name: 'registered and spec-only routes', extend: registerSpecRoutes },
])(
  'all: authorisation matrix (generated) over the $name (architecture §5.2, §8.2)',
  ({ extend }) => {
    const h = apiHarness(extend ? { extend } : {});
    const routes = declaredRoutes(h);
    let clientToken: string;
    let therapistToken: string;
    beforeAll(async () => {
      clientToken = (await h.seedClient('enabled')).token;
      therapistToken = (await h.seedTherapist()).token;
    });

    // Value: protects=no route is served without an access declaration, so the matrix below cannot miss one; fails_when=a route is registered with plain `api.get`/`openapi` and createRoute, bypassing defineRoute, or is hidden from the registry; why_new=first generated matrix; seam=Hono's route table; no_claim=routes outside /api/v1 (none exist)
    it('every route the app serves is declared with an access level', () => {
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) expect(ACCESS_LEVELS, label(route)).toContain(route.access);
      const declared = new Set(
        routes.map(
          (r) => `${r.method} ${API_BASE_PATH}${r.path.replaceAll(/\{([^}]+)\}/g, ':$1')}`,
        ),
      );
      const served = new Set(
        h.app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`),
      );
      expect([...served].filter((route) => !declared.has(route))).toEqual([]);
    });

    // Value: protects=every protected route refuses an anonymous caller; fails_when=a route is declared public by mistake or the middleware is missing; why_new=generated over all routes; seam=none; no_claim=the routes' behaviour when authorised
    it('every protected route × no token → 401 unauthenticated', async () => {
      for (const route of routes.filter((r) => r.access !== 'public')) {
        const res = await h.call(route.method, requestPath(route.path));
        expect(res.status, label(route)).toBe(401);
        expect(res.body.code, label(route)).toBe('unauthenticated');
      }
    });

    // Value: protects=a client token opens no therapist route; fails_when=a /admin route is declared member; why_new=generated over all routes; seam=none; no_claim=ownership checks
    it('every therapist route (/admin/*) × client token → 403 forbidden', async () => {
      for (const route of routes.filter((r) => r.access === 'therapist')) {
        const res = await h.call(route.method, requestPath(route.path), { token: clientToken });
        expect(res.status, label(route)).toBe(403);
        expect(res.body.code, label(route)).toBe('forbidden');
      }
    });

    // Value: protects=/admin/* routes are therapist-only by declaration, as §5.2 requires; fails_when=an /admin path is declared member or public; why_new=generated; seam=none; no_claim=none
    it('every /admin/* route is declared therapist', () => {
      for (const route of routes.filter((r) => r.path.startsWith('/admin/'))) {
        expect(route.access, label(route)).toBe('therapist');
      }
    });

    // Value: protects=the access level does not over-refuse: the roles it admits get past the guard; fails_when=member routes refuse the therapist or a client, or public routes demand a token; why_new=generated; seam=none; no_claim=the status the handler then returns
    it('every route lets through the callers its level admits', async () => {
      for (const route of routes) {
        const callers =
          route.access === 'public'
            ? [undefined]
            : route.access === 'member'
              ? [clientToken, therapistToken]
              : [therapistToken];
        for (const token of callers) {
          const res = await h.call(route.method, requestPath(route.path), token ? { token } : {});
          expect([401, 403], label(route)).not.toContain(res.status);
        }
      }
    });

    // Value: protects=every route with a body schema rejects a body of the wrong type as validation_failed with locations; fails_when=a route skips the defaultHook or answers 500 on a bad body; why_new=generated per route from the declarations; seam=none; no_claim=the field-level rules of each schema
    it('every route with a body × a body of the wrong type → 400 validation_failed', async () => {
      for (const route of routes.filter((r) => r.hasBody)) {
        const res = await h.call(route.method, requestPath(route.path), {
          token: therapistToken,
          json: ['not', 'an', 'object'],
        });
        expect(res.status, label(route)).toBe(400);
        expect(res.body.code, label(route)).toBe('validation_failed');
        expect(res.body.errors.length, label(route)).toBeGreaterThan(0);
      }
    });
  },
);
