import { TZDate, tzOffset } from '@date-fns/tz';
import { format } from 'date-fns';

/**
 * Time helpers (docs/architecture.md §5.5, S1). Slots are defined in local wall-clock time in
 * the therapist's zone and stored as UTC instants, so a 09:00 slot stays 09:00 across DST.
 *
 * Conventions: a local date is `yyyy-mm-dd`, a local time is `HH:mm` (00:00–23:59), an instant
 * is a `Date` (persisted as a UTC ISO string).
 */
export const THERAPIST_TIME_ZONE = 'Europe/Rome';

/**
 * Supported years. Before 1900 some zones (Rome until 1893) ran on local mean time, whose offsets
 * are fractional minutes; years below 100 are not representable through `Date.UTC`.
 */
export const MIN_YEAR = 1900;
export const MAX_YEAR = 9999;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The shapes of a local date and time, for the OpenAPI `pattern`. `ISO_DATE_SHAPE` cannot say
 * "a real date in a supported year"; `isIsoDate` and `isLocalTime` remain the full checks.
 */
export const ISO_DATE_SHAPE: RegExp = ISO_DATE;
export const LOCAL_TIME_SHAPE: RegExp = LOCAL_TIME;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * A local time that the zone skips because its clocks jump forward: the spring-forward gap
 * (02:30 on 2027-03-28 in Rome), and in some zones a whole skipped day or a midnight shift.
 */
export class NonexistentLocalTimeError extends RangeError {
  constructor(
    readonly date: string,
    readonly time: string,
    readonly timeZone: string,
  ) {
    super(`${date} ${time} does not exist in ${timeZone}: the clocks skip it`);
    this.name = 'NonexistentLocalTimeError';
  }
}

/** A time zone that is not an IANA name or offset the runtime knows, e.g. `Europe/Rme`. */
export class InvalidTimeZoneError extends RangeError {
  constructor(readonly timeZone: string) {
    super(`Unknown time zone "${timeZone}"`);
    this.name = 'InvalidTimeZoneError';
  }
}

/**
 * A local date or time that is not well formed (`2027-02-30`, `9:00`). Named so the API maps it
 * to `validation_failed` when request input reaches a helper, while a plain `RangeError` from a
 * programming mistake stays a 500.
 */
export class InvalidLocalValueError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLocalValueError';
  }
}

/** True for a real calendar date written as `yyyy-mm-dd`, in {@link MIN_YEAR}–{@link MAX_YEAR}. */
export function isIsoDate(value: string): boolean {
  return dateParts(value) !== undefined;
}

/** True for `HH:mm` between 00:00 and 23:59. */
export function isLocalTime(value: string): boolean {
  return LOCAL_TIME.test(value);
}

/**
 * The UTC instant of a local wall-clock time in `timeZone`.
 * Throws {@link NonexistentLocalTimeError} for a time the zone skips (the spring-forward gap).
 * An ambiguous time in the fall-back hour resolves to its first occurrence (summer time).
 */
export function localDateTimeToUtc(
  date: string,
  time: string,
  timeZone: string = THERAPIST_TIME_ZONE,
): Date {
  const [y, m, d] = requireDate(date);
  const match = LOCAL_TIME.exec(time);
  if (!match) throw new InvalidLocalValueError(`Invalid local time "${time}", expected HH:mm`);
  requireTimeZone(timeZone);
  // The wall-clock reading as if it were UTC. The real instant is `wall - offset` for one of
  // the zone's offsets around that day (one before a DST change, one after; they are equal on
  // ordinary days). Keep the candidates whose local reading round-trips: none is the
  // spring-forward gap, two is the fall-back overlap, where the earlier one is chosen. This
  // never consults the host's time zone, so a laptop in Rome and a Lambda in UTC agree.
  // The round-trip reads through the same tz engine as the offsets, so it checks consistency,
  // not the tz data itself; the specs pin known instants for that.
  const wall = Date.UTC(y, m - 1, d, Number(match[1]), Number(match[2]));
  const offsets = new Set([
    tzOffset(timeZone, new Date(wall - DAY_MS)),
    tzOffset(timeZone, new Date(wall + DAY_MS)),
  ]);
  const candidates = [...offsets]
    .map((offsetMinutes) => new Date(wall - offsetMinutes * MINUTE_MS))
    .filter((instant) => localDateOf(instant, timeZone) === date)
    .filter((instant) => localTimeOf(instant, timeZone) === time)
    .sort((a, b) => a.getTime() - b.getTime());
  const first = candidates[0];
  if (!first) throw new NonexistentLocalTimeError(date, time, timeZone);
  return first;
}

/** The local calendar date (`yyyy-mm-dd`) of an instant in `timeZone`. */
export function localDateOf(instant: Date, timeZone: string = THERAPIST_TIME_ZONE): string {
  requireTimeZone(timeZone);
  return format(new TZDate(instant.getTime(), timeZone), 'yyyy-MM-dd');
}

/** The local wall-clock time (`HH:mm`) of an instant in `timeZone`. */
export function localTimeOf(instant: Date, timeZone: string = THERAPIST_TIME_ZONE): string {
  requireTimeZone(timeZone);
  return format(new TZDate(instant.getTime(), timeZone), 'HH:mm');
}

/**
 * Calendar arithmetic on a local date; independent of DST because no instant is involved.
 * `days` must be a whole number, and the result must stay in {@link MIN_YEAR}–{@link MAX_YEAR}.
 */
export function addLocalDays(date: string, days: number): string {
  const [y, m, d] = requireDate(date);
  if (!Number.isInteger(days)) throw new RangeError(`Days must be a whole number, got ${days}`);
  const result = new Date(Date.UTC(y, m - 1, d + days));
  const year = result.getUTCFullYear();
  if (!(year >= MIN_YEAR && year <= MAX_YEAR)) {
    throw new RangeError(`${date} + ${days} days is outside ${MIN_YEAR}–${MAX_YEAR}`);
  }
  return result.toISOString().slice(0, 10);
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
  if (y < MIN_YEAR || y > MAX_YEAR) return undefined;
  const probe = new Date(Date.UTC(y, m - 1, d));
  const real =
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  return real ? [y, m, d] : undefined;
}

function requireDate(value: string): [number, number, number] {
  const parts = dateParts(value);
  if (!parts)
    throw new InvalidLocalValueError(`Invalid date "${value}", expected a real yyyy-mm-dd`);
  return parts;
}

const knownTimeZones = new Set<string>();

/** `Intl` knows every IANA name; `tzOffset` alone reads `Foo+05` as UTC+5 and fails late. */
function requireTimeZone(timeZone: string): void {
  if (knownTimeZones.has(timeZone)) return;
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    throw new InvalidTimeZoneError(timeZone);
  }
  knownTimeZones.add(timeZone);
}
