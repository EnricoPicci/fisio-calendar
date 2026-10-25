import { type DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  type NotificationChannel,
  type OutboundMessage,
  PermanentError,
  RetryableError,
  type SendResult,
} from '@fisio/domain';
import { closeTestDocumentClient, TEST_TABLE, testDocumentClient } from '@fisio/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { createNotifierHandler, deliverEvent, Notifier } from '../../src/notify/notifier';
import {
  notificationMonthOf,
  notificationPk,
  previousNotificationMonth,
} from '../../src/repo/keys';
import { NotificationRepository } from '../../src/repo/notifications';
import { type ApiHarness, apiHarness } from '../harness';
import { rawItem, setRaw, writeInvitation } from './outbox';

afterAll(closeTestDocumentClient);

const iso = (date: Date) => date.toISOString();

/** The harness's notifier over its repository, with some repository calls replaced. */
function notifierWith(
  h: ApiHarness,
  overrides: Partial<Pick<NotificationRepository, 'get' | 'transition'>>,
): Notifier {
  const repo = h.notifications;
  const notifications = {
    get: repo.get.bind(repo),
    transition: repo.transition.bind(repo),
    findDue: repo.findDue.bind(repo),
    findSendingSince: repo.findSendingSince.bind(repo),
    ...overrides,
  } as unknown as NotificationRepository;
  return new Notifier({
    notifications,
    channels: { email: h.channel },
    clock: h.clock,
    log: (event, details) => h.notifierLog.push([event, details]),
  });
}

describe('S3 Delivery: the notifier applies the delivery state machine on DynamoDB Local (architecture §5.4)', () => {
  // Value: protects=a committed notification is rendered, sent once and recorded as sent with the provider's id; fails_when=the notifier skips the pending→sending step, sends the raw params, or never writes sent; why_new=first notifier; seam=FakeChannel; no_claim=SMTP/SES behaviour (channel specs)
  it('pending → sending → sent on provider success', async () => {
    const h = apiHarness();
    const ref = await writeInvitation(h);
    const report = await h.notifier.deliver(h.tenantId, [ref]);
    expect(report.sent.map((sent) => sent.key)).toEqual([ref.key]);
    expect(h.channel.sent).toEqual([
      expect.objectContaining({
        channel: 'email',
        notificationKey: ref.key,
        to: ref.to,
        subject: 'Il tuo invito a Fisio Calendar',
        text: expect.stringContaining('Ciao Giulia Bianchi'),
        html: expect.stringContaining('<a href="https://fisio.test/">'),
      }),
    ]);
    expect(await rawItem(h, ref)).toMatchObject({
      status: 'sent',
      attempts: 0,
      providerMessageId: 'fake-1',
      sentAt: iso(h.clock.now()),
      updatedAt: iso(h.clock.now()),
    });
  });

  // Value: protects=a transient failure is retried after 1, 5, 30 and 120 minutes with the error kept, and the success then clears it from the item; fails_when=nextAttemptAt ignores the back-off table, attempts is not incremented, or a transition SETs fields without REMOVEing dropped ones (lastError survives the success); why_new=first notifier; seam=FakeChannel.failNext; no_claim=the table values themselves (domain spec)
  it('retryable error → pending with nextAttemptAt per back-off table; attempts incremented', async () => {
    const h = apiHarness();
    const ref = await writeInvitation(h);
    h.channel.failNext(new RetryableError('SMTP 451'));
    expect((await h.notifier.deliver(h.tenantId, [ref])).retrying).toHaveLength(1);
    const start = h.clock.now().getTime();
    expect(await rawItem(h, ref)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'SMTP 451',
      nextAttemptAt: iso(new Date(start + 60_000)),
    });

    // Not due 59 s later; due at the minute.
    h.clock.advance({ seconds: 59 });
    expect((await h.notifier.deliver(h.tenantId, [ref])).skipped).toHaveLength(1);
    h.clock.advance({ seconds: 1 });
    h.channel.failNext(new RetryableError('SMTP 421'));
    await h.notifier.deliver(h.tenantId, [ref]);
    expect(await rawItem(h, ref)).toMatchObject({
      attempts: 2,
      nextAttemptAt: iso(new Date(h.clock.now().getTime() + 5 * 60_000)),
    });

    h.clock.advance({ minutes: 5 });
    await h.notifier.deliver(h.tenantId, [ref]);
    const sent = await rawItem(h, ref);
    expect(sent).toMatchObject({ status: 'sent', attempts: 2, providerMessageId: 'fake-1' });
    expect(sent).not.toHaveProperty('lastError');
  });

  // Value: protects=an undeliverable message fails at once and raises the therapist alert (the log line the failed-notifications alarm counts); fails_when=a PermanentError is retried, or the alert is not raised; why_new=first notifier; seam=FakeChannel.failNext, the harness's notifier log; no_claim=the therapist's FAIL email (WP2.5)
  it('permanent error → failed + therapist alert', async () => {
    const h = apiHarness();
    const ref = await writeInvitation(h);
    h.channel.failNext(new PermanentError('SMTP 553 at RCPT TO'));
    expect((await h.notifier.deliver(h.tenantId, [ref])).failed).toHaveLength(1);
    expect(await rawItem(h, ref)).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'SMTP 553 at RCPT TO',
    });
    expect(h.notifierLog.filter(([event]) => event === 'notification_failed')).toEqual([
      [
        'notification_failed',
        expect.objectContaining({ kind: 'invitation', lastError: 'SMTP 553 at RCPT TO' }),
      ],
    ]);
    expect(h.channel.sent).toEqual([]);
  });

  // Value: protects=an item whose template params no longer fit fails permanently instead of being retried five times; fails_when=a render error escapes classification as retryable; why_new=first notifier; seam=params written directly; no_claim=template wording (contracts spec)
  it('a template that cannot render its params → failed without a send', async () => {
    const h = apiHarness();
    const ref = await writeInvitation(h, { params: { name: 'Anna' } });
    await h.notifier.deliver(h.tenantId, [ref]);
    expect(await rawItem(h, ref)).toMatchObject({
      status: 'failed',
      lastError: 'template invitation: invalid params email, appUrl',
    });
    expect(h.channel.sent).toEqual([]);
  });

  // Value: protects=retries stop after the fifth failed attempt, even for transient errors, and alert; fails_when=the attempt limit is off by one or not applied by the notifier; why_new=domain covers the arithmetic, this the stored item across real ticks; seam=FakeChannel.failNext; no_claim=manual retry (T9, WP2.6)
  it('attempts ≥ 5 → failed', async () => {
    const h = apiHarness();
    const ref = await writeInvitation(h);
    h.channel.failNext(...Array.from({ length: 5 }, () => new RetryableError('timeout')));
    for (const wait of [0, 1, 5, 30, 120]) {
      h.clock.advance({ minutes: wait });
      await h.notifier.deliverDue(h.tenantId);
    }
    expect(await rawItem(h, ref)).toMatchObject({ status: 'failed', attempts: 5 });
    h.clock.advance({ days: 1 });
    expect((await h.notifier.deliverDue(h.tenantId)).sent).toEqual([]);
    expect(h.channel.sent).toEqual([]);
  });

  // Value: protects=an item a crashed notifier left in sending is recovered as one failed attempt after more than 10 minutes, never sooner, and a provider id left on it is removed; fails_when=the sweep window is off, sweeps fresh sending items (double send), or the stale providerMessageId survives the REMOVE; why_new=first sweep; seam=raw item state; no_claim=the Lambda timeout bound (infra, WP0.9)
  it('sweep counts `sending` older than 10 min as a failed attempt', async () => {
    const h = apiHarness();
    const ref = await writeInvitation(h);
    await setRaw(h, ref, { status: 'sending', providerMessageId: 'stale-id' });
    h.clock.advance({ minutes: 10 });
    // Nothing comes back from the repository: the notifier's own staleness check is not the guard.
    expect(await h.notifier.sweep(h.tenantId)).toMatchObject({ retrying: [], skipped: [] });
    expect((await rawItem(h, ref)).status).toBe('sending');

    h.clock.advance({ seconds: 1 });
    expect((await h.notifier.sweep(h.tenantId)).retrying).toHaveLength(1);
    const swept = await rawItem(h, ref);
    expect(swept).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAttemptAt: iso(new Date(h.clock.now().getTime() + 60_000)),
    });
    expect(swept).not.toHaveProperty('providerMessageId');
    expect(h.notifierLog.map(([event]) => event)).toContain('notification_swept');
  });

  // Value: protects=the tick sends exactly the items whose time has come, in this month's and last month's partitions, also across the new year; fails_when=the filter ignores nextAttemptAt, misses the previous month (an item created on the 31st), computes January's previous month as `yyyy-00` instead of last December, or reads sent and failed items; why_new=first deliver-due, the year boundary from the ship coverage audit; seam=items written at chosen instants; no_claim=older partitions (TODOS: manual retry re-homing)
  it('deliver-due picks items whose nextAttemptAt elapsed; ignores others', async () => {
    const h = apiHarness();
    const now = h.clock.now();
    const due = await writeInvitation(h);
    const lastMonth = await writeInvitation(h, { at: new Date('2027-02-28T22:00:00.000Z') });
    expect(lastMonth.month).toBe(previousNotificationMonth(notificationMonthOf(now)));
    expect(
      previousNotificationMonth(notificationMonthOf(new Date('2027-01-01T00:30:00.000Z'))),
    ).toBe('2026-12');
    const backingOff = await writeInvitation(h);
    h.channel.failNext(new RetryableError('busy'));
    await h.notifier.deliver(h.tenantId, [backingOff]);
    const failed = await writeInvitation(h);
    h.channel.failNext(new PermanentError('bad'));
    await h.notifier.deliver(h.tenantId, [failed]);
    const future = await writeInvitation(h, { at: new Date(now.getTime() + 60_000) });

    const report = await h.notifier.deliverDue(h.tenantId);
    expect(report.sent.map((ref) => ref.key).sort()).toEqual([due.key, lastMonth.key].sort());
    // The repository's filter returns only due items; the notifier's re-check skips none.
    expect(report.skipped).toEqual([]);
    expect(h.channel.sent.map((m) => m.to).sort()).toEqual([due.to, lastMonth.to].sort());
    expect((await rawItem(h, backingOff)).status).toBe('pending');
    expect((await rawItem(h, future)).status).toBe('pending');
  });

  // Value: protects=Lambda's own retries and a tick racing the async invoke cannot send an email twice; fails_when=pending → sending is not a conditional write on the state read; why_new=first notifier; seam=two concurrent deliver events through the in-process invoker; no_claim=Lambda's retry policy
  it('duplicate async invocations deliver once (conditional pending → sending)', async () => {
    const h = apiHarness();
    const ref = await writeInvitation(h);
    const event = deliverEvent(h.tenantId, [ref]);
    await Promise.all([
      h.invoker.invoke('notifier', event),
      h.invoker.invoke('notifier', event),
      h.invoker.invoke('notifier', { kind: 'deliver-due', tenantId: h.tenantId }),
    ]);
    await h.invoker.settled();
    expect(h.channel.sent).toHaveLength(1);
    expect((await rawItem(h, ref)).status).toBe('sent');
  });

  // Value: protects=a notifier that resumes after its item was swept and re-sent cannot overwrite the newer attempt with its late result; fails_when=transitions are fenced on status only (TODOS P1 "Fence notifier writes on the delivery attempt"); why_new=first conditional writes; seam=a channel whose first send blocks until released; no_claim=avoiding the second email itself (the sweep window bounds it)
  it('a late result of a swept attempt does not overwrite the newer one', async () => {
    const h = apiHarness();
    const ref = await writeInvitation(h);
    let release: (result: SendResult) => void = () => {};
    let started: () => void = () => {};
    const firstSendStarted = new Promise<void>((resolve) => (started = resolve));
    const calls: OutboundMessage[] = [];
    const slow: NotificationChannel = {
      channel: 'email',
      send: (message) => {
        calls.push(message);
        if (calls.length > 1) return Promise.resolve({ providerMessageId: 'second' });
        started();
        return new Promise((resolve) => (release = resolve));
      },
    };
    const notifier = new Notifier({
      notifications: h.notifications,
      channels: { email: slow },
      clock: h.clock,
      log: (event, details) => h.notifierLog.push([event, details]),
    });
    const first = notifier.deliver(h.tenantId, [ref]);
    await firstSendStarted;

    h.clock.advance({ minutes: 11 });
    await notifier.sweep(h.tenantId);
    h.clock.advance({ minutes: 1 });
    await notifier.deliverDue(h.tenantId);
    release({ providerMessageId: 'first' });
    await first;

    expect(await rawItem(h, ref)).toMatchObject({
      status: 'sent',
      providerMessageId: 'second',
      attempts: 1,
    });
    expect(h.notifierLog).toContainEqual([
      'notification_outcome_lost',
      expect.objectContaining({ outcome: 'sent' }),
    ]);
  });

  // Value: protects=one corrupt item is logged and skipped while the others still go out; fails_when=a schema failure aborts the whole run, the corrupt item is sent, or an item whose sort key is not a notification key is built into a ref; why_new=TODOS "Notifier edge cases" (parse stored instants at the boundary); seam=raw attribute overwrite; no_claim=repairing the item
  it('a stored item that no longer matches its schema is logged and skipped; the others are sent', async () => {
    const h = apiHarness();
    const corrupt = await writeInvitation(h);
    await setRaw(h, corrupt, { updatedAt: 'yesterday' });
    const fine = await writeInvitation(h);
    const report = await h.notifier.deliverDue(h.tenantId);
    expect(report.sent).toEqual([{ month: fine.month, key: fine.key }]);
    expect(h.channel.sentTo(corrupt.to)).toEqual([]);
    expect(h.notifierLog).toContainEqual([
      'notification_corrupt',
      expect.objectContaining({ ref: { month: corrupt.month, key: corrupt.key } }),
    ]);

    // An item in the partition whose sort key is not a notification key is never turned into a ref.
    const stray = await writeInvitation(h);
    await testDocumentClient().send(
      new PutCommand({
        TableName: TEST_TABLE,
        Item: {
          ...(await rawItem(h, stray)),
          PK: notificationPk(h.tenantId, stray.month),
          SK: 'CLIENT#stray',
        },
      }),
    );
    await h.notifier.deliver(h.tenantId, [stray]);
    h.notifierLog.length = 0;
    expect((await h.notifier.deliverDue(h.tenantId)).sent).toEqual([]);
    expect(h.notifierLog).toContainEqual([
      'notification_corrupt',
      expect.objectContaining({ ref: { month: stray.month, key: 'CLIENT#stray' } }),
    ]);
  });

  // Value: protects=on the async-invoke path a corrupt item is logged and skipped like in deliver-due, while an item that cannot be processed fails the run only after the others went out; fails_when=a corrupt item burns Lambda's retries, or one broken item stops the rest; why_new=WP0.6 review (deliver and deliver-due disagreed on corrupt items; the aggregate path had no spec); seam=a repository whose get fails for one item; no_claim=Lambda's retry policy
  it('deliver-by-ids skips a corrupt item and fails the run for a broken one after the others', async () => {
    const h = apiHarness();
    const corrupt = await writeInvitation(h);
    await setRaw(h, corrupt, { updatedAt: 'yesterday' });
    const broken = await writeInvitation(h);
    const fine = await writeInvitation(h);
    const notifier = notifierWith(h, {
      get: (tenantId, ref) =>
        ref.key === broken.key
          ? Promise.reject(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }))
          : h.notifications.get(tenantId, ref),
    });
    const error = await notifier.deliver(h.tenantId, [corrupt, broken, fine]).catch((e) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(1);
    expect(h.channel.sent.map((m) => m.to)).toEqual([fine.to]);
    expect(h.notifierLog.map(([event]) => event)).toEqual([
      'notification_corrupt',
      'notification_delivery_error',
    ]);
  });

  // Value: protects=an item stuck in sending on its fifth attempt is failed by the sweep and alerts the therapist; fails_when=the sweep ignores the attempt limit and keeps retrying, or fails silently; why_new=WP0.6 review (only the first sweep was covered); seam=raw item state; no_claim=the FAIL email (WP2.5)
  it('the sweep fails a stuck item at the attempt limit and alerts', async () => {
    const h = apiHarness();
    const ref = await writeInvitation(h);
    await setRaw(h, ref, { status: 'sending', attempts: 4 });
    h.clock.advance({ minutes: 11 });
    const report = await h.notifier.sweep(h.tenantId);
    expect(report.failed).toEqual([{ month: ref.month, key: ref.key }]);
    expect(await rawItem(h, ref)).toMatchObject({ status: 'failed', attempts: 5 });
    expect(h.notifierLog.map(([event]) => event)).toContain('notification_failed');
  });

  // Value: protects=an item for a channel with no adapter fails at once and alerts instead of retrying for two hours; fails_when=the missing channel is treated as a transient error; why_new=WP0.6 review (guard untested); seam=a notifier built with no channels; no_claim=WhatsApp (later option)
  it('an item whose channel has no adapter fails at once', async () => {
    const h = apiHarness();
    const ref = await writeInvitation(h);
    const notifier = new Notifier({
      notifications: h.notifications,
      channels: {},
      clock: h.clock,
      log: (event, details) => h.notifierLog.push([event, details]),
    });
    expect((await notifier.deliver(h.tenantId, [ref])).failed).toHaveLength(1);
    expect((await rawItem(h, ref)).status).toBe('failed');
    expect(h.notifierLog.map(([event]) => event)).toContain('notification_failed');
  });

  // Value: protects=a late failure of an attempt the sweep already replaced does not overwrite the newer attempt nor alert; fails_when=the failed-attempt write is fenced on status only, so a sent item becomes pending or failed again; why_new=state-machine review of WP0.6 (the sent side was covered, the failed side not); seam=a channel whose first send blocks until rejected; no_claim=none
  it('a late failed attempt of a swept item does not overwrite the newer one', async () => {
    const h = apiHarness();
    const ref = await writeInvitation(h);
    let reject: (error: unknown) => void = () => {};
    let started: () => void = () => {};
    const firstSendStarted = new Promise<void>((resolve) => (started = resolve));
    let sends = 0;
    const slow: NotificationChannel = {
      channel: 'email',
      send: () => {
        sends += 1;
        if (sends > 1) return Promise.resolve({ providerMessageId: 'second' });
        started();
        return new Promise((_, fail) => (reject = fail));
      },
    };
    const notifier = new Notifier({
      notifications: h.notifications,
      channels: { email: slow },
      clock: h.clock,
      log: (event, details) => h.notifierLog.push([event, details]),
    });
    const first = notifier.deliver(h.tenantId, [ref]);
    await firstSendStarted;
    h.clock.advance({ minutes: 11 });
    await notifier.sweep(h.tenantId);
    h.clock.advance({ minutes: 1 });
    await notifier.deliverDue(h.tenantId);
    reject(new PermanentError('late'));

    expect((await first).skipped).toHaveLength(1);
    expect(await rawItem(h, ref)).toMatchObject({
      status: 'sent',
      providerMessageId: 'second',
      attempts: 1,
    });
    expect(h.notifierLog).toContainEqual([
      'notification_outcome_lost',
      expect.objectContaining({ outcome: 'failed attempt' }),
    ]);
    expect(h.notifierLog.map(([event]) => event)).not.toContain('notification_failed');
  });

  // Value: protects=once the provider accepted, a DynamoDB error on the sent write is retried, and if it persists the run still reports the send instead of failing; fails_when=the error escapes (Lambda retries skip the sending item and the sweep sends the email again ten minutes later); why_new=WP0.6 review; seam=a repository whose sent write fails; no_claim=the duplicate when every retry fails (logged as notification_outcome_lost)
  it('a DynamoDB error on the sent write is retried, never rethrown', async () => {
    const h = apiHarness();
    const throttled = () =>
      Promise.reject(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    const once = await writeInvitation(h);
    let failures = 0;
    const flaky = notifierWith(h, {
      transition: (tenantId, ref, from, to) =>
        to.status === 'sent' && failures++ === 0
          ? throttled()
          : h.notifications.transition(tenantId, ref, from, to),
    });
    expect((await flaky.deliver(h.tenantId, [once])).sent).toHaveLength(1);
    expect((await rawItem(h, once)).status).toBe('sent');

    const never = await writeInvitation(h);
    const down = notifierWith(h, {
      transition: (tenantId, ref, from, to) =>
        to.status === 'sent' ? throttled() : h.notifications.transition(tenantId, ref, from, to),
    });
    expect((await down.deliver(h.tenantId, [never])).sent).toHaveLength(1);
    expect(h.notifierLog).toContainEqual([
      'notification_outcome_lost',
      expect.objectContaining({ outcome: 'sent' }),
    ]);
    expect(h.channel.sent).toHaveLength(2);
  });

  // Value: protects=a transition DynamoDB committed but whose answer was lost (the SDK retried after a timeout) counts as applied, so the send goes ahead and a permanent failure still raises the therapist alert; fails_when=the retry's ConditionalCheckFailed reads as "the item moved on" (no send until the sweep, no notification_failed for the alarm), or any refused retry counts as applied, even one that finds another writer's state (a second send); why_new=ship review (red team); seam=a document client that commits each update and then answers like the SDK's refused retry; no_claim=the SDK's retry policy itself
  it('a transition whose answer was lost after it committed counts as applied', async () => {
    const h = apiHarness();
    const ref = await writeInvitation(h);
    const doc = testDocumentClient();
    const lostAnswers = {
      send: async (command: unknown) => {
        if (!(command instanceof UpdateCommand)) return doc.send(command as never);
        await doc.send(command);
        // The SDK's retry of the committed write, refused because the item already moved.
        const retried = await doc.send(command).catch((error: unknown) => error);
        Object.assign(retried as object, { $metadata: { attempts: 2 } });
        throw retried;
      },
    } as unknown as DynamoDBDocumentClient;
    const lossy = new NotificationRepository(lostAnswers, TEST_TABLE);
    h.channel.failNext(new PermanentError('SMTP 550'));
    const notifier = notifierWith(h, { transition: lossy.transition.bind(lossy) });
    expect((await notifier.deliver(h.tenantId, [ref])).failed).toHaveLength(1);
    expect(await rawItem(h, ref)).toMatchObject({ status: 'failed', lastError: 'SMTP 550' });
    const events = h.notifierLog.map(([event]) => event);
    expect(events).toContain('notification_failed');
    expect(events).not.toContain('notification_outcome_lost');

    // A retry refused because another writer moved the item meanwhile is not this call's write.
    const taken = await writeInvitation(h);
    const otherWriter = {
      send: async (command: unknown) => {
        if (!(command instanceof UpdateCommand)) return doc.send(command as never);
        await setRaw(h, taken, { status: 'sending', updatedAt: '2027-03-01T08:59:00.000Z' });
        const refused = await doc.send(command).catch((error: unknown) => error);
        Object.assign(refused as object, { $metadata: { attempts: 2 } });
        throw refused;
      },
    } as unknown as DynamoDBDocumentClient;
    const late = new NotificationRepository(otherWriter, TEST_TABLE);
    const racing = notifierWith(h, { transition: late.transition.bind(late) });
    expect((await racing.deliver(h.tenantId, [taken])).skipped).toHaveLength(1);
    expect(h.channel.sentTo(taken.to)).toEqual([]);
  });

  // Value: protects=log lines carry the error's name and message only, never the provider error kept as cause (SES and SMTP echo the recipient there); fails_when=the raw error object is logged; why_new=WP0.6 security review; seam=FakeChannel failing with a cause; no_claim=what CloudWatch keeps
  it('logs a failed attempt by error name and message only', async () => {
    const h = apiHarness();
    const ref = await writeInvitation(h);
    h.channel.failNext(
      new RetryableError('SMTP 452', { cause: new Error('mailbox giulia@example.test full') }),
    );
    await h.notifier.deliver(h.tenantId, [ref]);
    const [, details] =
      h.notifierLog.find(([event]) => event === 'notification_attempt_failed') ?? [];
    expect(details?.error).toEqual({ name: 'RetryableError', message: 'SMTP 452' });
    expect(details?.error).not.toBeInstanceOf(Error);
  });

  // Value: protects=an id of an item that does not exist, or an item already sent, is a no-op; fails_when=the notifier throws on a missing item (Lambda would retry forever) or resends a sent one; why_new=first deliver-by-ids; seam=none; no_claim=none
  it('deliver-by-ids skips unknown and already sent items', async () => {
    const h = apiHarness();
    const ref = await writeInvitation(h);
    await h.notifier.deliver(h.tenantId, [ref]);
    const unknown = { month: ref.month, key: ref.key.replace(/#1$/, '#2') as typeof ref.key };
    const again = await h.notifier.deliver(h.tenantId, [ref, unknown]);
    expect(again.skipped).toHaveLength(2);
    expect(h.channel.sent).toHaveLength(1);
  });
});

describe('S3 Delivery: the notifier entry point (architecture §4.3, §5.4)', () => {
  // Value: protects=the notifier accepts only the events the API and the jobs tick send, and SNS feedback reaches the ses-feedback stub without touching the outbox; fails_when=a malformed or foreign event is silently accepted, or an SNS record is parsed as a delivery; why_new=first handler; seam=handler called directly; no_claim=bounce handling (WP2.5)
  it('routes deliver, deliver-due and sweep events, logs SES feedback, refuses anything else', async () => {
    const h = apiHarness();
    const log: string[] = [];
    const handler = createNotifierHandler(h.notifier, (event) => log.push(event));
    const ref = await writeInvitation(h);
    await handler({ kind: 'deliver', tenantId: h.tenantId, notifications: [ref] });
    expect(h.channel.sent).toHaveLength(1);
    await handler({ kind: 'sweep', tenantId: h.tenantId });
    await handler({ kind: 'deliver-due', tenantId: h.tenantId });

    await handler({
      Records: [
        {
          EventSource: 'aws:sns',
          Sns: { Message: JSON.stringify({ notificationType: 'Bounce' }) },
        },
      ],
    });
    expect(log).toEqual(['ses_feedback_ignored']);

    for (const bad of [
      {},
      { kind: 'deliver', tenantId: h.tenantId, notifications: [] },
      {
        kind: 'deliver',
        tenantId: h.tenantId,
        notifications: [{ month: ref.month, key: 'CLIENT#x' }],
      },
      { kind: 'deliver-due', tenantId: 'T#other' },
    ]) {
      await expect(handler(bad), JSON.stringify(bad)).rejects.toThrow();
    }
  });
});
