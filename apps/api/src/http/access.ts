import { ClientIdSchema, type ErrorCode, type TenantId } from '@fisio/contracts';
import { createRoute, type RouteConfig } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { InvalidTokenError, type TokenVerifier } from '../identity/token-verifier';
import type { ClientRecord, ClientRepository } from '../repo/clients';
import type { SettingsRepository } from '../repo/settings';
import { ApiError } from './problem';
import { problemResponses } from './responses';

/**
 * Who may call a route (docs/architecture.md §5.2, §8.2). Every route declares one level, once,
 * with {@link defineRoute}; the declaration attaches the middleware that enforces it, documents
 * it in the OpenAPI document (`x-access`, `security`) and is what the generated authorisation
 * matrix spec iterates over.
 *
 * - `public`: no token (`/health`).
 * - `member`: a client or the therapist (`/me`, `/me/*`, `/slots`).
 * - `therapist`: the therapist only (`/admin/*`).
 */
export const ACCESS_LEVELS = ['public', 'member', 'therapist'] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

export interface ClientCaller {
  readonly role: 'client';
  readonly tenantId: TenantId;
  readonly clientId: ClientRecord['clientId'];
  readonly client: ClientRecord;
}

export interface TherapistCaller {
  readonly role: 'therapist';
  readonly tenantId: TenantId;
  readonly therapistId: string;
}

export type Caller = ClientCaller | TherapistCaller;

export interface ApiEnv {
  Variables: { caller: Caller };
}

export interface AuthDeps {
  readonly tokens: TokenVerifier;
  readonly clients: ClientRepository;
  readonly settings: SettingsRepository;
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

/**
 * The checks of §8.2, in order: a bearer token (else 401), a valid access token (else 401), the
 * role the route needs (else 403), then the caller's current state, read strongly consistent on
 * every request (else 403): a client item with status `enabled`, or for the therapist the
 * tenant's Settings item. So a block, an erasure or a pending invitation takes effect on the
 * next request, not at token expiry.
 */
export function authorize(access: Access, deps: AuthDeps): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (access === 'public') return next();
    const token = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
    if (!token) throw new ApiError('unauthenticated');
    const claims = await deps.tokens.verify(token).catch((error: unknown) => {
      throw error instanceof InvalidTokenError
        ? new ApiError('unauthenticated', { cause: error })
        : error;
    });
    if (access === 'therapist' && claims.role !== 'therapist') throw new ApiError('forbidden');

    if (claims.role === 'client') {
      const clientId = ClientIdSchema.parse(claims.sub);
      const client = await deps.clients.get(claims.tenantId, clientId);
      if (client?.status !== 'enabled') throw new ApiError('forbidden');
      c.set('caller', { role: 'client', tenantId: claims.tenantId, clientId, client });
    } else {
      if (!(await deps.settings.exists(claims.tenantId))) throw new ApiError('forbidden');
      c.set('caller', { role: 'therapist', tenantId: claims.tenantId, therapistId: claims.sub });
    }
    await next();
  };
}

/** The caller of a `member` or `therapist` route; set by {@link authorize}. */
export function callerOf(c: Context<ApiEnv>): Caller {
  const caller = c.get('caller');
  if (!caller) throw new Error('callerOf used on a route without authorize');
  return caller;
}

const ACCESS_PROBLEMS: Record<Access, readonly ErrorCode[]> = {
  public: [],
  member: ['unauthenticated', 'forbidden'],
  therapist: ['unauthenticated', 'forbidden'],
};

/**
 * A route with its access level: `createRoute` plus the {@link authorize} middleware (before
 * the request validators, so a missing token is 401, never 400), the `x-access` extension, the
 * bearer `security` requirement, and the problem responses its level and validation can give.
 */
export function defineRoute<const R extends RouteConfig>(
  access: Access,
  deps: AuthDeps,
  config: R,
) {
  const validated = config.request !== undefined;
  return createRoute({
    ...config,
    middleware: [authorize(access, deps)] as const,
    'x-access': access,
    ...(access === 'public' ? {} : { security: [{ bearerAuth: [] }] }),
    responses: {
      ...problemResponses([
        ...(validated ? (['validation_failed'] as const) : []),
        ...ACCESS_PROBLEMS[access],
        'internal_error',
      ]),
      ...config.responses,
    },
  });
}
