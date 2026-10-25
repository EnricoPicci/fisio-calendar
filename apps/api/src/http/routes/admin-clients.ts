import { AddClientRequestSchema, type AdminClient, AdminClientSchema } from '@fisio/contracts';
import type { ClientRecord } from '../../repo/clients';
import { type AddClientDeps, addClient, ClientExistsError } from '../../usecases/add-client';
import { type AuthDeps, callerOf, defineRoute } from '../access';
import { ApiError } from '../problem';
import { problemResponses } from '../responses';
import type { ApiRouter } from '../router';

/** `POST /admin/clients` (T7): add a client, who receives an invitation email. */
export function registerAdminClients(api: ApiRouter, deps: AuthDeps & AddClientDeps): void {
  const route = defineRoute('therapist', deps, {
    method: 'post',
    path: '/admin/clients',
    summary: 'Add a client and send the invitation',
    request: {
      body: { required: true, content: { 'application/json': { schema: AddClientRequestSchema } } },
    },
    responses: {
      201: {
        description: 'The client, invited',
        content: { 'application/json': { schema: AdminClientSchema } },
      },
      ...problemResponses(['client_exists']),
    },
  });
  api.openapi(route, async (c) => {
    const { tenantId } = callerOf(c);
    try {
      const client = await addClient(deps, tenantId, c.req.valid('json'));
      return c.json(adminClientOf(client), 201);
    } catch (error) {
      if (error instanceof ClientExistsError) throw new ApiError('client_exists', { cause: error });
      throw error;
    }
  });
}

/** Built field by field: a stored item is never spread into a response (§9.2). */
export function adminClientOf(client: ClientRecord): AdminClient {
  return {
    clientId: client.clientId,
    name: client.name,
    email: client.email,
    ...(client.phone ? { phone: client.phone } : {}),
    status: client.status,
    ...(client.invitedAt ? { invitedAt: client.invitedAt } : {}),
    createdAt: client.createdAt,
  };
}
