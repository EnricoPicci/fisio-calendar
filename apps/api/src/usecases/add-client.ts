import {
  type AddClientRequest,
  ClientIdSchema,
  type TemplateParams,
  type TenantId,
} from '@fisio/contracts';
import {
  type AsyncInvoker,
  type Clock,
  type IdentityProvider,
  type IdentityUser,
  isErrorNamed,
} from '@fisio/domain';
import { deliverEvent } from '../notify/notifier';
import {
  ClientItemBusyError,
  ClientItemExistsError,
  type ClientRecord,
  type ClientRepository,
} from '../repo/clients';
import { NotificationKeys } from '../repo/keys';
import type { NotificationRepository } from '../repo/notifications';

/** What {@link addClient} needs. */
export interface AddClientDeps {
  readonly identity: IdentityProvider;
  readonly clients: ClientRepository;
  readonly notifications: NotificationRepository;
  readonly invoker: AsyncInvoker;
  readonly clock: Clock;
  /** The SPA's origin; the invitation links to it. */
  readonly webOrigin: string;
  /** Reports a failure the caller is not told about (the async invoke, a failed clean-up). */
  readonly log: (error: unknown) => void;
}

/** A client, or another user of the pool, already has this email. */
export class ClientExistsError extends Error {
  override readonly name = 'ClientExistsError';
}

/**
 * Add a client (docs/architecture.md §3.3 T7, §8.1), minimal for WP0.6: the identity user, then
 * the client item (`invited`) and its first INVITE notification in one transaction, then an
 * async invoke of the notifier so the invitation goes out at once. Editing, blocking and
 * resending invitations arrive with WP1.5, the audit item with WP1.6.
 */
export async function addClient(
  deps: AddClientDeps,
  tenantId: TenantId,
  request: AddClientRequest,
): Promise<ClientRecord> {
  const now = deps.clock.now();
  const { user, created } = await identityUser(deps, tenantId, request.email);
  const clientId = ClientIdSchema.parse(user.userId);
  const params: TemplateParams<'invitation'> = {
    name: request.name,
    email: request.email,
    appUrl: `${deps.webOrigin}/`,
  };
  const invitation = deps.notifications.newItem(
    tenantId,
    {
      key: NotificationKeys.invitation(clientId, 1),
      kind: 'invitation',
      template: 'invitation',
      params,
      channel: 'email',
      to: request.email,
      clientId,
    },
    now,
  );

  let client: ClientRecord;
  try {
    client = await deps.clients.create(
      tenantId,
      {
        clientId,
        name: request.name,
        email: request.email,
        ...(request.phone ? { phone: request.phone } : {}),
        status: 'invited',
        locale: 'it',
        channels: { email: true, whatsapp: false },
        emailStatus: 'ok',
        invitedAt: now.toISOString(),
        createdAt: now.toISOString(),
      },
      [invitation.put],
    );
  } catch (error) {
    if (error instanceof ClientItemExistsError)
      throw new ClientExistsError(error.message, { cause: error });
    // Another add of this email (a double tap) took over the user as a left-over and is writing
    // the same items: that add owns the user now, so it stays and this one answers client_exists.
    if (error instanceof ClientItemBusyError)
      throw new ClientExistsError(error.message, { cause: error });
    if (isErrorNamed(error, 'TransactionCanceledException')) {
      // DynamoDB refused the transaction, so nothing was written: a user this call created would
      // block every retry with client_exists. A reused left-over user is not this call's to drop.
      if (created) await deps.identity.deleteUser(user.userId).catch(deps.log);
      throw error;
    }
    // Any other error (a timeout, a transaction still in progress) may come with a commit, now or
    // a moment later, so the user always stays: a retry takes it over as a left-over.
    let committed: ClientRecord | undefined;
    try {
      committed = await deps.clients.get(tenantId, clientId);
    } catch (readError) {
      deps.log(readError);
      throw error;
    }
    if (!committed) throw error;
    deps.log(error);
    client = committed;
  }

  // After the commit, never instead of it: if the invoke fails, the next tick delivers the item.
  await deps.invoker.invoke('notifier', deliverEvent(tenantId, [invitation.ref])).catch(deps.log);
  return client;
}

/**
 * A new identity user for the email, or the one an earlier add left behind when its transaction
 * failed after the user was created (no client item for it in this tenant), so that add can be
 * retried. Any other existing user is a duplicate.
 */
async function identityUser(
  deps: AddClientDeps,
  tenantId: TenantId,
  email: string,
): Promise<{ user: IdentityUser; created: boolean }> {
  try {
    return { user: await deps.identity.createUser({ email, role: 'client' }), created: true };
  } catch (error) {
    if (!isErrorNamed(error, 'IdentityUserExistsError')) throw error;
    const existing = await deps.identity.findUserByEmail(email);
    const leftOver =
      existing?.role === 'client' &&
      existing.enabled &&
      (await deps.clients.get(tenantId, ClientIdSchema.parse(existing.userId))) === undefined;
    if (!existing || !leftOver)
      throw new ClientExistsError('A client with this email exists', { cause: error });
    return { user: existing, created: false };
  }
}
