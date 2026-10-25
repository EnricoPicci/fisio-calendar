import { randomUUID } from 'node:crypto';
import {
  type DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { BookingIdSchema, type ClientId, ClientIdSchema } from '@fisio/contracts';
import type { AsyncInvoker } from '@fisio/domain';
import { closeTestDocumentClient, TEST_TABLE, testDocumentClient } from '@fisio/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { ClientItemBusyError, ClientItemExistsError, ClientRepository } from '../src/repo/clients';
import { isNotificationKey, NotificationKeys, notificationMonthOf } from '../src/repo/keys';
import { addClient } from '../src/usecases/add-client';
import { type ApiHarness, apiHarness, SPEC_WEB_ORIGIN } from './harness';
import { rawItem } from './notify/outbox';

afterAll(closeTestDocumentClient);

const newEmail = () => `cliente-${randomUUID()}@example.test`;

async function addAs(h: ApiHarness, body: unknown) {
  const { token } = await h.seedTherapist();
  return h.call('POST', '/admin/clients', { token, json: body });
}

describe('T7 Manage clients: adding a client sends the invitation (architecture §3.3, §5.4)', () => {
  // Value: protects=adding a client creates the identity user, an invited client item and its INVITE notification together, and the async invoke delivers the invitation at once; fails_when=any of the three is missing, the client id is not the identity sub, the invoke happens before the commit, or the email is not rendered from the stored params; why_new=first add-client; seam=the emulator's identity provider, FakeChannel, in-process invoker; no_claim=Cognito's AdminCreateUser (contract spec, WP0.10)
  it('add client → identity user created, invitation notification written and delivered', async () => {
    const h = apiHarness();
    const email = newEmail();
    const res = await addAs(h, {
      name: 'Giulia Bianchi',
      email: ` ${email.toUpperCase()} `,
      phone: '+393331234567',
    });
    expect(res.status).toBe(201);
    const user = await h.identity.findUserByEmail(email);
    expect(user).toMatchObject({ email, role: 'client', enabled: true, passwordSet: false });
    expect(res.body).toEqual({
      clientId: user?.userId,
      name: 'Giulia Bianchi',
      email,
      phone: '+393331234567',
      status: 'invited',
      invitedAt: h.clock.now().toISOString(),
      createdAt: h.clock.now().toISOString(),
    });
    const clientId = ClientIdSchema.parse(user?.userId);
    expect(await h.clients.get(h.tenantId, clientId)).toMatchObject({
      status: 'invited',
      channels: { email: true, whatsapp: false },
      emailStatus: 'ok',
    });

    await h.invoker.settled();
    const ref = {
      month: notificationMonthOf(h.clock.now()),
      key: NotificationKeys.invitation(clientId, 1),
    };
    expect(await rawItem(h, ref)).toMatchObject({
      kind: 'invitation',
      template: 'invitation',
      clientId,
      to: email,
      status: 'sent',
      params: { name: 'Giulia Bianchi', email, appUrl: `${SPEC_WEB_ORIGIN}/` },
    });
    const [invitation, ...others] = h.channel.sentTo(email);
    expect(others).toEqual([]);
    expect(invitation).toMatchObject({
      notificationKey: ref.key,
      subject: 'Il tuo invito a Fisio Calendar',
    });
    expect(invitation?.text).toContain(`${SPEC_WEB_ORIGIN}/`);
  });

  // Value: protects=one mailbox is one client: a second add with the same email (any letter case) is refused and changes nothing; fails_when=a duplicate identity user, client item or invitation is created, or the error is not client_exists; why_new=first add-client; seam=none; no_claim=the GSI2 lookup by email (WP1.5)
  it('duplicate email → 409 client_exists', async () => {
    const h = apiHarness();
    const email = newEmail();
    expect((await addAs(h, { name: 'Marco Rossi', email })).status).toBe(201);
    const again = await addAs(h, { name: 'Marco R.', email: email.toUpperCase() });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('client_exists');
    await h.invoker.settled();
    expect(h.channel.sentTo(email)).toHaveLength(1);
  });

  // Value: protects=only an enabled client user with no client item counts as a left-over; the therapist's own address, or a disabled user, is never turned into a new client account; fails_when=an existing user of another role, or a disabled one, is reused as a left-over (the invited client could never sign in); why_new=first add-client, the disabled case from the ship coverage audit; seam=users created and disabled in the emulator pool; no_claim=re-enabling a blocked client (WP1.5)
  it("the therapist's email, or a disabled user's, → 409 client_exists", async () => {
    const h = apiHarness();
    const therapistEmail = newEmail();
    await h.identity.createUser({ email: therapistEmail, role: 'therapist' });
    const disabledEmail = newEmail();
    const disabled = await h.identity.createUser({ email: disabledEmail, role: 'client' });
    await h.identity.disableUser(disabled.userId);
    for (const email of [therapistEmail, disabledEmail]) {
      const res = await addAs(h, { name: 'Anna Verdi', email });
      expect(res.status, email).toBe(409);
      expect(res.body.code, email).toBe('client_exists');
    }
    expect(await h.clients.get(h.tenantId, ClientIdSchema.parse(disabled.userId))).toBeUndefined();
  });

  // Value: protects=the add-client transaction tells "this client item exists" (client_exists) and "another write of these items is running" (a TransactionConflict at any index) from any other cancellation, such as a taken outbox key, and writes nothing when cancelled; fails_when=create maps any ConditionalCheckFailed reason (not the client item's, index 0) to ClientItemExistsError, or drops the client item's attribute_not_exists; why_new=the existing specs reach client_exists only through the identity provider, never through the transaction; seam=two creates sharing a key, on DynamoDB Local; no_claim=the race between two concurrent adds of one email (identity provider refuses the second)
  it('the transaction refuses an existing client item as ClientItemExistsError, a concurrent write as ClientItemBusyError, a taken outbox key as another error', async () => {
    const h = apiHarness();
    const invitation = (clientId: ClientId) =>
      h.notifications.newItem(
        h.tenantId,
        {
          key: NotificationKeys.invitation(clientId, 1),
          kind: 'invitation',
          template: 'invitation',
          params: {},
          channel: 'email',
          to: 'x@example.test',
        },
        h.clock.now(),
      );
    const record = (clientId: ClientId) => ({
      clientId,
      name: 'Paola Conti',
      email: `${clientId}@example.test`,
      status: 'invited' as const,
      locale: 'it' as const,
      createdAt: h.clock.now().toISOString(),
    });
    const first = ClientIdSchema.parse(randomUUID());
    await h.clients.create(h.tenantId, record(first), [invitation(first).put]);

    const otherKey = ClientIdSchema.parse(randomUUID());
    await expect(
      h.clients.create(h.tenantId, record(first), [invitation(otherKey).put]),
    ).rejects.toBeInstanceOf(ClientItemExistsError);
    expect(await rawItem(h, invitation(otherKey).ref)).toBeUndefined();

    const second = ClientIdSchema.parse(randomUUID());
    const error = await h.clients
      .create(h.tenantId, record(second), [invitation(first).put])
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ClientItemExistsError);
    expect(error).toMatchObject({ name: 'TransactionCanceledException' });
    expect(await h.clients.get(h.tenantId, second)).toBeUndefined();

    // A conflict on any of the items, the outbox one included, is a concurrent write.
    const conflict = (codes: string[]) =>
      new ClientRepository(
        {
          send: async () => {
            throw Object.assign(new Error('Transaction cancelled'), {
              name: 'TransactionCanceledException',
              CancellationReasons: codes.map((Code) => ({ Code })),
            });
          },
        } as unknown as DynamoDBDocumentClient,
        TEST_TABLE,
      ).create(h.tenantId, record(second), [invitation(second).put]);
    await expect(conflict(['TransactionConflict', 'None'])).rejects.toBeInstanceOf(
      ClientItemBusyError,
    );
    await expect(conflict(['None', 'TransactionConflict'])).rejects.toBeInstanceOf(
      ClientItemBusyError,
    );
  });

  // Value: protects=the request is validated before anything is created; fails_when=an invalid email or unknown field reaches the identity provider; why_new=first validated body route; seam=none; no_claim=every Zod issue code (problem-details spec)
  it('an invalid body → 400 validation_failed with the paths, nothing created', async () => {
    const h = apiHarness();
    const res = await addAs(h, { name: '', email: 'not-an-email', role: 'therapist' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors.map((e: { path: string[] }) => e.path.join('.')).sort()).toEqual([
      '',
      'email',
      'name',
    ]);
  });

  // Value: protects=a failed async invoke never fails a committed add, and the next deliver-due sends the invitation; fails_when=the invoke error turns the 201 into a 500 (the therapist retries and gets client_exists) or the item is not left pending; why_new=first use of the invoke; seam=an invoker that throws; no_claim=Lambda's async retries
  it('a failed async invoke still answers 201; the next deliver-due sends the invitation', async () => {
    const h = apiHarness();
    const failing: AsyncInvoker = {
      invoke: async () => {
        throw new Error('Lambda throttled');
      },
    };
    const email = newEmail();
    const logged: unknown[] = [];
    const client = await addClient(
      { ...useCaseDeps(h), invoker: failing, log: (error) => logged.push(error) },
      h.tenantId,
      { name: 'Sara Marino', email },
    );
    expect(logged).toEqual([expect.objectContaining({ message: 'Lambda throttled' })]);
    expect(h.channel.sentTo(email)).toEqual([]);
    await h.notifier.deliverDue(h.tenantId);
    expect(h.channel.sentTo(email)).toHaveLength(1);
    expect(client.status).toBe('invited');
  });

  // Value: protects=a transaction DynamoDB cancelled removes the identity user this add created (a retry is not blocked by client_exists) but never a reused left-over user, and any other failure keeps the user for the retry to take over; fails_when=a cancelled add leaves its user, the `created` guard is dropped (a reused user another add may own is deleted), or a generic error deletes a user whose transaction may still commit; why_new=first add-client, the delete rule from the ship review (red team); seam=ClientRepository subclasses whose transaction fails; no_claim=Cognito's delete (contract spec)
  it('a cancelled transaction removes only the identity user it created; any other failure keeps the user for the retry', async () => {
    const h = apiHarness();
    const failing = (error: Error) =>
      new (class extends ClientRepository {
        override async create(): Promise<never> {
          throw error;
        }
      })(testDocumentClient(), TEST_TABLE);
    const cancelled = failing(
      Object.assign(new Error('Transaction cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ValidationError' }, { Code: 'None' }],
      }),
    );
    const add = (clients: ClientRepository, email: string) =>
      addClient({ ...useCaseDeps(h), clients }, h.tenantId, { name: 'Luca Ferrari', email });

    const fresh = newEmail();
    await expect(add(cancelled, fresh)).rejects.toMatchObject({
      name: 'TransactionCanceledException',
    });
    expect(await h.identity.findUserByEmail(fresh)).toBeUndefined();

    // A crash between createUser and the transaction leaves a user without a client item: a
    // cancelled add that reused it leaves it in place.
    const reused = newEmail();
    const leftOver = await h.identity.createUser({ email: reused, role: 'client' });
    await expect(add(cancelled, reused)).rejects.toMatchObject({
      name: 'TransactionCanceledException',
    });
    expect(await h.identity.findUserByEmail(reused)).toMatchObject({ userId: leftOver.userId });

    // A failure that is not a cancellation may still commit: the user stays, the retry reuses it.
    const unsure = newEmail();
    await expect(add(failing(new Error('DynamoDB unavailable')), unsure)).rejects.toThrow(
      'DynamoDB unavailable',
    );
    const kept = await h.identity.findUserByEmail(unsure);
    expect(kept).toBeDefined();
    const client = await add(h.clients, unsure);
    expect(client.clientId).toBe(kept?.userId);
  });

  // Value: protects=a transaction that committed but answered with an error (a timeout after DynamoDB accepted it) keeps the identity user and completes the add, so no committed client is left without a login; fails_when=every error but client_exists deletes the created user; why_new=WP0.6 review (ambiguous commit); seam=a ClientRepository whose transaction commits and then throws; no_claim=a commit that cannot be read back either (the error is returned)
  it('a transaction that committed but reported an error keeps the user and completes the add', async () => {
    const h = apiHarness();
    const email = newEmail();
    const ambiguous = new (class extends ClientRepository {
      override async create(...args: Parameters<ClientRepository['create']>): Promise<never> {
        await super.create(...args);
        throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
      }
    })(testDocumentClient(), TEST_TABLE);
    const client = await addClient({ ...useCaseDeps(h), clients: ambiguous }, h.tenantId, {
      name: 'Marta Greco',
      email,
    });
    expect(client).toMatchObject({ email, status: 'invited' });
    expect(await h.identity.findUserByEmail(email)).toMatchObject({ userId: client.clientId });
    expect(h.loggedErrors).toContainEqual(expect.objectContaining({ name: 'TimeoutError' }));
    await h.invoker.settled();
    expect(h.channel.sentTo(email)).toHaveLength(1);
  });

  // Value: protects=when neither the transaction nor the read-back can tell whether the add committed, the identity user is kept and a retry takes it over, so a committed client never loses its login; fails_when=a failed read-back counts as "not committed" and deletes the user; why_new=ship review (security specialist); seam=a ClientRepository whose create and get fail; no_claim=Cognito's own retries (contract spec, WP0.10)
  it('a transaction whose outcome cannot be read back keeps the user, and a retry completes the add', async () => {
    const h = apiHarness();
    const email = newEmail();
    const commitError = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
    const readError = Object.assign(new Error('read timed out'), { name: 'RequestTimeout' });
    const blind = new (class extends ClientRepository {
      override async create(): Promise<never> {
        throw commitError;
      }
      override async get(): Promise<never> {
        throw readError;
      }
    })(testDocumentClient(), TEST_TABLE);
    await expect(
      addClient({ ...useCaseDeps(h), clients: blind }, h.tenantId, { name: 'Paolo Neri', email }),
    ).rejects.toBe(commitError);
    const kept = await h.identity.findUserByEmail(email);
    expect(kept).toBeDefined();
    expect(h.loggedErrors).toEqual([readError]);

    const client = await addClient(useCaseDeps(h), h.tenantId, { name: 'Paolo Neri', email });
    expect(client.clientId).toBe(kept?.userId);
  });

  // Value: protects=a double tap on "add" never leaves a client item without its identity user: the add whose transaction DynamoDB cancels with TransactionConflict answers client_exists and keeps the user the other add took over; fails_when=a TransactionConflict is treated as "nothing written" and the created user is deleted while the other add commits; why_new=ship review (state-machines + testing specialists); seam=ClientRepository subclasses ordering the two adds (DynamoDB Local serialises transactions, so the conflict is injected); no_claim=DynamoDB's own conflict detection
  it('a double tap: the add cancelled by a TransactionConflict answers client_exists and the other add keeps the user', async () => {
    const h = apiHarness();
    const email = newEmail();
    let reachedCreate!: () => void;
    const reuserAtCreate = new Promise<void>((resolve) => {
      reachedCreate = resolve;
    });
    let release!: () => void;
    const reuserMayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new (class extends ClientRepository {
      override async create(...args: Parameters<ClientRepository['create']>) {
        reachedCreate();
        await reuserMayCommit;
        return super.create(...args);
      }
    })(testDocumentClient(), TEST_TABLE);
    let second: Promise<unknown> | undefined;
    // DynamoDB answers this add's transaction with TransactionConflict while the second tap,
    // started meanwhile, is about to commit; every other call reaches DynamoDB Local.
    const doc = testDocumentClient();
    const conflictingDoc = {
      send: async (command: unknown) => {
        if (!(command instanceof TransactWriteCommand)) return doc.send(command as never);
        second = addClient({ ...useCaseDeps(h), clients: waiting }, h.tenantId, {
          name: 'Giulia Rossi',
          email,
        });
        await reuserAtCreate;
        throw Object.assign(new Error('Transaction cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
        });
      },
    } as unknown as DynamoDBDocumentClient;
    const conflicting = new ClientRepository(conflictingDoc, TEST_TABLE);

    const first = addClient({ ...useCaseDeps(h), clients: conflicting }, h.tenantId, {
      name: 'Giulia Rossi',
      email,
    });
    await expect(first).rejects.toMatchObject({ name: 'ClientExistsError' });
    release();
    const client = (await second) as { clientId: ClientId };
    expect(await h.identity.findUserByEmail(email)).toMatchObject({ userId: client.clientId });
    expect(await h.clients.get(h.tenantId, client.clientId)).toMatchObject({ status: 'invited' });
  });

  // Value: protects=the INVITE key makes the outbox write idempotent: a second item with the same key is refused, so a rerun can never queue a second invitation; fails_when=newItem drops attribute_not_exists; why_new=first deterministic key; seam=the repository's TransactPut sent directly; no_claim=resend (INVITE attempt + 1, WP1.5)
  it('INVITE key idempotent: the same notification cannot be written twice', async () => {
    const h = apiHarness();
    const clientId = ClientIdSchema.parse(randomUUID());
    const item = () =>
      h.notifications.newItem(
        h.tenantId,
        {
          key: NotificationKeys.invitation(clientId, 1),
          kind: 'invitation',
          template: 'invitation',
          params: {},
          channel: 'email',
          to: 'x@example.test',
        },
        h.clock.now(),
      );
    await testDocumentClient().send(new PutCommand(item().put.Put));
    await expect(testDocumentClient().send(new PutCommand(item().put.Put))).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
    });
    expect(NotificationKeys.invitation(clientId, 2)).toBe(`INVITE#${clientId}#2`);
    expect(() => NotificationKeys.invitation(clientId, 0)).toThrow(RangeError);
  });

  // Value: protects=every notification kind has one deterministic key, so a rerun of the use case that creates it adds nothing; fails_when=a builder changes its parts or order, adds a time component, or accepts a malformed date; why_new=WP0.6 defines the keys WP1.3 and WP2.x use; seam=none; no_claim=the use cases that write them (later WPs)
  it('the keys for REM, CONF, CANC, DIGEST and FAIL are deterministic', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const bookingId = BookingIdSchema.parse(id);
    const clientId = ClientIdSchema.parse(id);
    const keys = [
      [NotificationKeys.confirmation(bookingId, 'email'), `CONF#${id}#email`],
      [NotificationKeys.cancellation(bookingId, 'email'), `CANC#${id}#email`],
      [NotificationKeys.reminder(bookingId, 'email', '2027-03-02'), `REM#${id}#email#2027-03-02`],
      [NotificationKeys.digest('2027-03-02'), 'DIGEST#2027-03-02#email'],
      [NotificationKeys.failure(clientId, '2027-03-02'), `FAIL#${id}#2027-03-02`],
    ];
    for (const [built, expected] of keys) {
      expect(built).toBe(expected);
      expect(isNotificationKey(built as string)).toBe(true);
    }
    expect(() => NotificationKeys.digest('2027-3-2')).toThrow(RangeError);
  });
});

function useCaseDeps(h: ApiHarness) {
  return {
    identity: h.identity,
    clients: h.clients,
    notifications: h.notifications,
    invoker: h.invoker,
    clock: h.clock,
    webOrigin: SPEC_WEB_ORIGIN,
    log: (error: unknown) => h.loggedErrors.push(error),
  };
}

describe('S3 Delivery: the invitation goes out through the async invoke (architecture §5.4)', () => {
  // Value: protects=the invitation is sent by the invoke that follows the commit, with no tick; fails_when=the invoke is missing or carries the wrong refs, so the email waits for the next tick (up to 15 minutes); why_new=catalogue row S3 (ship review: no spec carried its title); seam=the in-process invoker; no_claim=Lambda's Event invoke (lambda-async-invoker spec)
  it('async invoke after commit delivers immediately (in-process locally)', async () => {
    const h = apiHarness();
    const email = newEmail();
    expect((await addAs(h, { name: 'Ada Neri', email })).status).toBe(201);
    await h.invoker.settled();
    expect(h.channel.sentTo(email)).toHaveLength(1);
  });
});
