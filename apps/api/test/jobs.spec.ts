import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { closeTestDocumentClient, TEST_TABLE, testDocumentClient } from '@fisio/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createJobsHandler,
  dailyJob,
  deliveryJobs,
  nextLocalDay,
  runTick,
  type TickJob,
} from '../src/jobs/tick';
import { jobMarkerSk, tenantPk } from '../src/repo/keys';
import { apiHarness } from './harness';
import { rawItem, setRaw, writeInvitation } from './notify/outbox';

afterAll(closeTestDocumentClient);

describe('S3 Delivery: the jobs tick runs sweep and deliver-due (architecture §5.3)', () => {
  // Value: protects=every tick recovers stuck items and delivers what is due, through the notifier; fails_when=the jobs handler skips a delivery job, invokes the wrong event, or uses another instant than its clock; why_new=first jobs handler; seam=the harness's in-process invoker and FakeChannel; no_claim=EventBridge Scheduler (infra, WP0.9)
  it('a tick sweeps a stuck item and delivers a due one', async () => {
    const h = apiHarness();
    const due = await writeInvitation(h);
    const stuck = await writeInvitation(h);
    await setRaw(h, stuck, { status: 'sending' });
    h.clock.advance({ minutes: 11 });
    const handler = createJobsHandler({
      jobs: deliveryJobs(h.invoker),
      tenantId: h.tenantId,
      clock: h.clock,
      log: () => {},
    });
    await handler({ source: 'aws.scheduler' });
    await h.invoker.settled();
    expect(h.channel.sentTo(due.to)).toHaveLength(1);
    expect(await rawItem(h, stuck)).toMatchObject({ status: 'pending', attempts: 1 });

    // One minute later the swept item's back-off has run out.
    h.clock.advance({ minutes: 1 });
    await handler({});
    await h.invoker.settled();
    expect(h.channel.sentTo(stuck.to)).toHaveLength(1);
  });

  // Value: protects=a failing job neither hides its error nor stops the jobs after it; fails_when=runTick stops at the first failure or swallows it (no Lambda error, no alarm), or logs the raw error (its cause can carry addresses); why_new=first dispatcher; seam=recording jobs; no_claim=alarm wiring (WP2.7)
  it('a failing job is logged, the others still run, and the tick fails', async () => {
    const ran: string[] = [];
    const log: string[] = [];
    const job = (name: string, fail = false): TickJob => ({
      name,
      run: async () => {
        ran.push(name);
        if (fail) throw new Error(`${name} broke`);
        return 'ran';
      },
    });
    const context = { tenantId: apiHarness().tenantId, now: new Date('2027-03-01T08:00:00.000Z') };
    await expect(
      runTick([job('a'), job('b', true), job('c')], context, (event, details) =>
        log.push(`${event} ${String(details.job)} ${JSON.stringify(details.error)}`),
      ),
    ).rejects.toSatisfy((error) => error instanceof AggregateError && error.errors.length === 1);
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['job_failed b {"name":"Error","message":"b broke"}']);
  });
});

describe('S2 Reminders: the marker helper for once-a-day jobs (architecture §5.3)', () => {
  // Value: protects=a daily job runs at the first tick at or after its local time, once, and a later tick the same day repairs a missed run (catch-up); fails_when=the time is compared in UTC, the marker is written before the work, or checked for the wrong date; why_new=first marker helper, used by reminders, digest and extend-horizon later; seam=a counting job; no_claim=the reminder content (WP2.3)
  it('runs once per local day from its time on, catching up a missed run until midnight', async () => {
    const h = apiHarness();
    const runs: string[] = [];
    const reminders = dailyJob({
      name: 'reminders',
      markers: h.markers,
      notBefore: '19:00',
      markerDate: nextLocalDay,
      run: async (_, date) => {
        runs.push(date);
      },
    });
    const tick = (now: string) =>
      runTick([reminders], { tenantId: h.tenantId, now: new Date(now) }, () => {});
    // 18:45 in Rome (CET, UTC+1) is too early.
    expect(await tick('2027-03-01T17:45:00.000Z')).toEqual({ ran: [], skipped: ['reminders'] });
    // The 19:00 run was missed; 20:40 catches up, for tomorrow's date.
    expect(await tick('2027-03-01T19:40:00.000Z')).toEqual({ ran: ['reminders'], skipped: [] });
    expect(await tick('2027-03-01T22:45:00.000Z')).toEqual({ ran: [], skipped: ['reminders'] });
    expect(runs).toEqual(['2027-03-02']);
    expect(await h.markers.has(h.tenantId, 'reminders', '2027-03-02')).toBe(true);
  });

  // Value: protects=a crash between the job's work and its marker makes the next tick redo the work (whose writes are idempotent); fails_when=the marker is written first or despite the failure; why_new=first marker helper; seam=a job that fails once; no_claim=idempotency of the work itself (deterministic keys, per job)
  it('a failed run writes no marker, so the next tick runs it again', async () => {
    const h = apiHarness();
    let attempts = 0;
    const digest = dailyJob({
      name: 'digest',
      markers: h.markers,
      notBefore: async () => '07:30',
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('crash before the marker');
      },
    });
    const context = { tenantId: h.tenantId, now: new Date('2027-03-01T06:45:00.000Z') };
    await expect(runTick([digest], context, () => {})).rejects.toThrow();
    expect(await h.markers.has(h.tenantId, 'digest', '2027-03-01')).toBe(false);
    expect(await runTick([digest], context, () => {})).toEqual({ ran: ['digest'], skipped: [] });
    expect(attempts).toBe(2);
    // A concurrent tick writing the marker again is a no-op, not an error, and keeps the first run.
    await expect(
      h.markers.put(h.tenantId, 'digest', '2027-03-01', new Date('2027-03-01T09:00:00.000Z')),
    ).resolves.toBeUndefined();
    const { Item } = await testDocumentClient().send(
      new GetCommand({
        TableName: TEST_TABLE,
        Key: { PK: tenantPk(h.tenantId), SK: jobMarkerSk('digest', '2027-03-01') },
        ConsistentRead: true,
      }),
    );
    expect(Item?.ranAt).toBe('2027-03-01T06:45:00.000Z');
  });
});
