import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';

/**
 * Time helpers (docs/architecture.md §5.3, S1). Slots are defined in local wall-clock time in
 * the therapist's zone and stored as UTC instants, so a 09:00 slot stays 09:00 across DST.
 *
 * Conventions: a local date is `yyyy-mm-dd`, a local time is `HH:mm` (00:00–23:59), an instant
 * is a `Date` (persisted as a UTC ISO string).
 */
export const THERAPIST_TIME_ZONE = 'Europe/Rome';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A local time that the zone skips (the spring-forward gap), e.g. 02:30 on 2027-03-28 in Rome. */
export class NonexistentLocalTimeError extends RangeError {
  constructor(
    readonly date: string,
    readonly time: string,
    readonly timeZone: string,
  ) {
    super(`${date} ${time} does not exist in ${timeZone} (daylight saving gap)`);
    this.name = 'NonexistentLocalTimeError';
  }
}

/** True for a real calendar date written as `yyyy-mm-dd`. */
export function isIsoDate(value: string): boolean {
  return dateParts(value) !== undefined;
}

/** True for `HH:mm` between 00:00 and 23:59. */
export function isLocalTime(value: string): boolean {
  return LOCAL_TIME.test(value);
}

/**
 * The UTC instant of a local wall-clock time in `timeZone`.
 * Throws {@link NonexistentLocalTimeError} for a time inside the spring-forward gap.
 * An ambiguous time in the fall-back hour resolves to its first occurrence (summer time).
 */
export function localDateTimeToUtc(
  date: string,
  time: string,
  timeZone: string = THERAPIST_TIME_ZONE,
): Date {
  const [y, m, d] = requireDate(date);
  const match = LOCAL_TIME.exec(time);
  if (!match) throw new RangeError(`Invalid local time "${time}", expected HH:mm`);
  const zoned = new TZDate(y, m - 1, d, Number(match[1]), Number(match[2]), timeZone);
  // TZDate moves a nonexistent wall-clock time forward; detect that instead of guessing.
  if (format(zoned, 'yyyy-MM-dd HH:mm') !== `${date} ${time}`) {
    throw new NonexistentLocalTimeError(date, time, timeZone);
  }
  return new Date(zoned.getTime());
}

/** The local calendar date (`yyyy-mm-dd`) of an instant in `timeZone`. */
export function localDateOf(instant: Date, timeZone: string = THERAPIST_TIME_ZONE): string {
  return format(new TZDate(instant.getTime(), timeZone), 'yyyy-MM-dd');
}

/** The local wall-clock time (`HH:mm`) of an instant in `timeZone`. */
export function localTimeOf(instant: Date, timeZone: string = THERAPIST_TIME_ZONE): string {
  return format(new TZDate(instant.getTime(), timeZone), 'HH:mm');
}

/** Calendar arithmetic on a local date; independent of DST because no instant is involved. */
export function addLocalDays(date: string, days: number): string {
  const [y, m, d] = requireDate(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** ISO weekday of a local date: Monday = 1 … Sunday = 7. */
export function localWeekday(date: string): number {
  const [y, m, d] = requireDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
}

function dateParts(value: string): [number, number, number] | undefined {
  const match = ISO_DATE.exec(value);
  if (!match) return undefined;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  const real =
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  return real ? [y, m, d] : undefined;
}

function requireDate(value: string): [number, number, number] {
  const parts = dateParts(value);
  if (!parts) throw new RangeError(`Invalid date "${value}", expected a real yyyy-mm-dd`);
  return parts;
}
