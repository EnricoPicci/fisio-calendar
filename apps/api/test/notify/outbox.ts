import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ClientIdSchema } from '@fisio/contracts';
import { TEST_TABLE, testDocumentClient } from '@fisio/testkit';
import { NotificationKeys, notificationPk } from '../../src/repo/keys';
import type { NotificationRef } from '../../src/repo/notifications';
import type { ApiHarness } from '../harness';

/**
 * Outbox helpers for notifier and jobs specs: write an invitation item as a use case would (the
 * repository's `newItem`, put on its own), and read or bend the stored item directly.
 */
export async function writeInvitation(
  h: ApiHarness,
  options: { at?: Date; to?: string; params?: Record<string, unknown> } = {},
): Promise<NotificationRef & { to: string }> {
  const clientId = ClientIdSchema.parse(randomUUID());
  const to = options.to ?? `${clientId}@example.test`;
  const { ref, put } = h.notifications.newItem(
    h.tenantId,
    {
      key: NotificationKeys.invitation(clientId, 1),
      kind: 'invitation',
      template: 'invitation',
      params: options.params ?? {
        name: 'Giulia Bianchi',
        email: to,
        appUrl: 'https://fisio.test/',
      },
      channel: 'email',
      to,
      clientId,
    },
    options.at ?? h.clock.now(),
  );
  await testDocumentClient().send(new PutCommand(put.Put));
  return { ...ref, to };
}

// biome-ignore lint/suspicious/noExplicitAny: specs read stored items freely.
export async function rawItem(h: ApiHarness, ref: NotificationRef): Promise<any> {
  const { Item } = await testDocumentClient().send(
    new GetCommand({
      TableName: TEST_TABLE,
      Key: { PK: notificationPk(h.tenantId, ref.month), SK: ref.key },
      ConsistentRead: true,
    }),
  );
  return Item;
}

/** Overwrites stored attributes as corrupt data or a crashed notifier would leave them. */
export async function setRaw(
  h: ApiHarness,
  ref: NotificationRef,
  attributes: Record<string, unknown>,
): Promise<void> {
  const names = Object.keys(attributes);
  await testDocumentClient().send(
    new UpdateCommand({
      TableName: TEST_TABLE,
      Key: { PK: notificationPk(h.tenantId, ref.month), SK: ref.key },
      UpdateExpression: `SET ${names.map((_, i) => `#a${i} = :v${i}`).join(', ')}`,
      ExpressionAttributeNames: Object.fromEntries(names.map((name, i) => [`#a${i}`, name])),
      ExpressionAttributeValues: Object.fromEntries(
        names.map((name, i) => [`:v${i}`, attributes[name]]),
      ),
    }),
  );
}
