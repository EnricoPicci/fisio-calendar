import type { TenantId } from '@fisio/contracts';
import {
  type AsyncHandler,
  type AsyncInvoker,
  addLocalDays,
  type Clock,
  localDateOf,
  localTimeOf,
  THERAPIST_TIME_ZONE,
} from '@fisio/domain';
import { describeError, type NotifierEvent } from '../notify/notifier';
import type { JobMarkerRepository } from '../repo/job-markers';
import type { JobName } from '../repo/keys';

/**
 * The scheduler's tick (docs/architecture.md §3.1, §5.3): EventBridge Scheduler runs the `jobs`
 * Lambda every 15 minutes, locally `POST /__dev/tick` and `pnpm tick --now <iso>` run the same
 * code at a chosen instant. Each tick runs every job in order; a failing job is logged and does
 * not stop the others, and the tick then fails as a whole so the error alarm sees it.
 *
 * WP0.6 ticks the delivery jobs (sweep, then deliver-due, both in the notifier, which holds the
 * channel adapters). Extend-horizon, reminders and digest join as {@link dailyJob}s (WP1.2,
 * WP2.3, WP2.4).
 */
export interface TickContext {
  readonly tenantId: TenantId;
  /** The tick's instant; jobs read this, not the clock, so one tick sees one time. */
  readonly now: Date;
}

/** `skipped`: the job decided this tick has nothing to do. */
export type JobResult = 'ran' | 'skipped';

export interface TickJob {
  readonly name: string;
  run(context: TickContext): Promise<JobResult>;
}

export interface TickReport {
  readonly ran: readonly string[];
  readonly skipped: readonly string[];
}

export type TickLog = (event: string, details: Readonly<Record<string, unknown>>) => void;

export const consoleTickLog: TickLog = (event, details) => {
  console.error(`[jobs] ${event}`, details);
};

export async function runTick(
  jobs: readonly TickJob[],
  context: TickContext,
  log: TickLog,
): Promise<TickReport> {
  const ran: string[] = [];
  const skipped: string[] = [];
  const errors: unknown[] = [];
  for (const job of jobs) {
    try {
      const result = await job.run(context);
      (result === 'skipped' ? skipped : ran).push(job.name);
    } catch (error) {
      errors.push(error);
      log('job_failed', {
        job: job.name,
        now: context.now.toISOString(),
        error: describeError(error),
      });
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `${errors.length} job(s) failed`);
  return { ran, skipped };
}

/**
 * Sweep and deliver-due: two async invocations of the notifier (§5.3, §5.4). They are queued in
 * this order but may run concurrently in the cloud; neither depends on the other, because a swept
 * item waits out its back-off before deliver-due picks it up.
 */
export function deliveryJobs(invoker: AsyncInvoker): TickJob[] {
  const invokeNotifier = async (event: NotifierEvent): Promise<JobResult> => {
    await invoker.invoke('notifier', event);
    return 'ran';
  };
  return [
    { name: 'sweep', run: ({ tenantId }) => invokeNotifier({ kind: 'sweep', tenantId }) },
    {
      name: 'deliver-due',
      run: ({ tenantId }) => invokeNotifier({ kind: 'deliver-due', tenantId }),
    },
  ];
}

export interface DailyJobOptions {
  readonly name: JobName;
  readonly markers: JobMarkerRepository;
  /** Local wall-clock time (`HH:mm`, Europe/Rome) from which the job is due each day. */
  readonly notBefore: string | ((context: TickContext) => Promise<string>);
  /**
   * The local date the marker is written for, from today's local date: today by default, the
   * next day for reminders (`JOB#reminders#<tomorrow>`, §5.3).
   */
  readonly markerDate?: (today: string) => string;
  /** The work; it must be idempotent, because a crash before the marker makes a later tick redo it. */
  readonly run: (context: TickContext, markerDate: string) => Promise<void>;
}

/**
 * The marker helper (§5.3): a job that runs once per local day, at the first tick at or after
 * `notBefore` (catch-up: a missed or failed run is repaired by any later tick until local
 * midnight), and writes its marker only after the work succeeded.
 */
export function dailyJob(options: DailyJobOptions): TickJob {
  return {
    name: options.name,
    async run(context) {
      const today = localDateOf(context.now, THERAPIST_TIME_ZONE);
      const notBefore =
        typeof options.notBefore === 'string'
          ? options.notBefore
          : await options.notBefore(context);
      if (localTimeOf(context.now, THERAPIST_TIME_ZONE) < notBefore) return 'skipped';
      const date = options.markerDate?.(today) ?? today;
      if (await options.markers.has(context.tenantId, options.name, date)) return 'skipped';
      await options.run(context, date);
      await options.markers.put(context.tenantId, options.name, date, context.now);
      return 'ran';
    },
  };
}

/** The next local date: the marker date of the reminders job. */
export const nextLocalDay = (today: string): string => addLocalDays(today, 1);

/** The `jobs` Lambda's entry point: the scheduler's event carries nothing the tick needs. */
export function createJobsHandler(deps: {
  readonly jobs: readonly TickJob[];
  readonly tenantId: TenantId;
  readonly clock: Clock;
  readonly log: TickLog;
}): AsyncHandler {
  return async () => {
    await runTick(deps.jobs, { tenantId: deps.tenantId, now: deps.clock.now() }, deps.log);
  };
}
