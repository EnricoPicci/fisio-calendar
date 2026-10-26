import { closeTestDocumentClient, TestTokenIssuer } from '@fisio/testkit';
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
    /** Client tokens in the other states: invited, blocked, and no client item. */
    let otherClientTokens: string[];
    let invited: Awaited<ReturnType<typeof h.seedClient>>;
    beforeAll(async () => {
      clientToken = (await h.seedClient('enabled')).token;
      therapistToken = (await h.seedTherapist()).token;
      invited = await h.seedClient('invited');
      otherClientTokens = [
        invited.token,
        (await h.seedClient('blocked')).token,
        h.token(crypto.randomUUID(), 'client'),
      ];
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
      // `ALL` entries are middleware (`use`), allowed only on wildcard paths: an `all()` or `use()`
      // on a concrete path could answer requests without a declaration.
      const served = new Set(
        h.app.routes
          .filter((r) => r.method !== 'ALL' || !r.path.endsWith('*'))
          .map((r) => `${r.method} ${r.path}`),
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

    // Value: protects=a token that does not verify is refused as unauthenticated on every protected route, before any role or status check; fails_when=a route skips verification or a parse/signature failure becomes 403 or 500; why_new=only /me was driven with invalid tokens; seam=a second issuer with the same kid; no_claim=the individual verifier rules (authentication.spec.ts)
    it('every protected route × invalid token → 401 unauthenticated', async () => {
      const forger = new TestTokenIssuer({ kid: h.issuer.kid });
      const forged = forger.accessToken(
        { sub: crypto.randomUUID(), role: 'therapist', tenantId: h.tenantId },
        { issuedAt: h.clock.now() },
      );
      for (const route of routes.filter((r) => r.access !== 'public')) {
        for (const token of ['not.a.jwt', forged]) {
          const res = await h.call(route.method, requestPath(route.path), { token });
          expect(res.status, label(route)).toBe(401);
          expect(res.body.code, label(route)).toBe('unauthenticated');
        }
      }
    });

    // Value: protects=a client token opens no therapist route, whatever the client's status, and an invited client's token there does not accept the invitation; fails_when=a /admin route is declared member, or the role check moves after the status check (which lets some status through or enables an invited client); why_new=generated over all routes and client states; seam=none; no_claim=ownership checks
    it('every therapist route (/admin/*) × any client token → 403 forbidden', async () => {
      for (const route of routes.filter((r) => r.access === 'therapist')) {
        for (const token of [clientToken, ...otherClientTokens]) {
          const res = await h.call(route.method, requestPath(route.path), { token });
          expect(res.status, label(route)).toBe(403);
          expect(res.body.code, label(route)).toBe('forbidden');
        }
      }
      // The role check comes first: an invited client's token on a therapist route accepts nothing.
      expect((await h.clients.get(h.tenantId, invited.clientId))?.status).toBe('invited');
    });

    // Value: protects=the client-status check runs on every member route, not only GET /me; fails_when=one member route skips or reorders the status check, so a blocked or erased client gets in; why_new=member routes were only driven with admitted tokens; seam=none; no_claim=the routes' own behaviour
    it('every member route × blocked or unknown client token → 403 forbidden', async () => {
      const refused = otherClientTokens.filter((token) => token !== invited.token);
      for (const route of routes.filter((r) => r.access === 'member')) {
        for (const token of refused) {
          const res = await h.call(route.method, requestPath(route.path), { token });
          expect(res.status, label(route)).toBe(403);
          expect(res.body.code, label(route)).toBe('forbidden');
        }
      }
    });

    // Value: protects=a therapist token opens nothing until its tenant is bootstrapped, on member and therapist routes alike; fails_when=the Settings check is skipped for one access level; why_new=only GET /me was tested (client-status.spec.ts); seam=a second harness whose tenant has no Settings item; no_claim=the bootstrap CLI (WP0.5)
    it('every protected route × therapist of a tenant without its Settings item → 403 forbidden', async () => {
      const bare = apiHarness(extend ? { extend } : {});
      const token = bare.token(crypto.randomUUID(), 'therapist');
      for (const route of routes.filter((r) => r.access !== 'public')) {
        const res = await bare.call(route.method, requestPath(route.path), { token });
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

    // Value: protects=the access level does not over-refuse: the roles it admits get past the guard, and a public route ignores any Authorization header; fails_when=member routes refuse the therapist or a client, or public routes demand, verify or status-check a token; why_new=generated; seam=none; no_claim=the status the handler then returns
    it('every route lets through the callers its level admits', async () => {
      for (const route of routes) {
        const callers =
          route.access === 'public'
            ? [undefined, 'not.a.jwt', clientToken, therapistToken, ...otherClientTokens]
            : route.access === 'member'
              ? [clientToken, therapistToken]
              : [therapistToken];
        for (const token of callers) {
          const res = await h.call(route.method, requestPath(route.path), token ? { token } : {});
          expect([401, 403], label(route)).not.toContain(res.status);
        }
        // Each member route admits an invited client too, accepting the invitation (§8.2).
        if (route.access === 'member') {
          const { token } = await h.seedClient('invited');
          const res = await h.call(route.method, requestPath(route.path), { token });
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
