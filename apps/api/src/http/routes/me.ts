import { type MeResponse, MeResponseSchema } from '@fisio/contracts';
import { type AuthDeps, type Caller, callerOf, defineRoute } from '../access';
import type { ApiRouter } from '../router';

/** `GET /me`: the caller's profile and role (§5.2). The therapist's settings come with WP1.1. */
export function registerMe(api: ApiRouter, deps: AuthDeps): void {
  const route = defineRoute('member', deps, {
    method: 'get',
    path: '/me',
    summary: "The caller's profile and role",
    responses: {
      200: {
        description: 'The caller',
        content: { 'application/json': { schema: MeResponseSchema } },
      },
    },
  });
  api.openapi(route, (c) => c.json(profileOf(callerOf(c)), 200));
}

/** Built field by field: a stored item is never spread into a response (§9.2). */
function profileOf(caller: Caller): MeResponse {
  if (caller.role === 'therapist') return { role: 'therapist', therapistId: caller.therapistId };
  const { client } = caller;
  return {
    role: 'client',
    clientId: client.clientId,
    name: client.name,
    email: client.email,
    ...(client.phone ? { phone: client.phone } : {}),
    locale: client.locale,
  };
}
