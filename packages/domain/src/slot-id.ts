import {
  isIsoDate,
  isLocalTime,
  localDateTimeToUtc,
  NonexistentLocalTimeError,
  THERAPIST_TIME_ZONE,
} from './time';

/**
 * Slot identity (docs/architecture.md §3.2, §5.1, decision 14A): `<date>T<HH:mm>#<type>`,
 * e.g. `2027-03-28T09:00#pool`. Unique within the therapist; date and start are local
 * (Europe/Rome) wall-clock values. This module is the only place that builds or reads one;
 * repository keys derive from it. Ids of one type sort chronologically as plain strings.
 *
 * `parse`, `of` and `is` check the format only, so a stored id stays readable whatever the
 * runtime's tz data says. Ids entering the system must also name a start that exists in Rome
 * (not inside the spring-forward gap): `format` enforces it, and request input goes through
 * `SlotIdSchema`, which checks {@link startExists}.
 */
export const SLOT_TYPES = ['studio', 'pool'] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

declare const slotIdBrand: unique symbol;
/** A validated slot id. Obtain one only through {@link SlotId}. */
export type SlotId = string & { readonly [slotIdBrand]: true };

export interface SlotIdParts {
  /** Local date, `yyyy-mm-dd`. */
  readonly date: string;
  /** Local start time, `HH:mm`. */
  readonly start: string;
  readonly type: SlotType;
}

export class InvalidSlotIdError extends Error {
  constructor(
    readonly input: string,
    reason: string,
  ) {
    super(`Invalid SlotId "${input}": ${reason}`);
    this.name = 'InvalidSlotIdError';
  }
}

const PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})#([a-z]+)$/;

function isSlotType(value: string): value is SlotType {
  return (SLOT_TYPES as readonly string[]).includes(value);
}

function check(input: string, parts: SlotIdParts): void {
  if (!isIsoDate(parts.date)) throw new InvalidSlotIdError(input, 'date is not a real yyyy-mm-dd');
  if (!isLocalTime(parts.start)) throw new InvalidSlotIdError(input, 'start is not HH:mm');
  if (!isSlotType(parts.type)) {
    throw new InvalidSlotIdError(input, `type must be one of ${SLOT_TYPES.join(', ')}`);
  }
}

/** False when the start falls in a gap the Rome clocks skip (02:30 on 2027-03-28). */
function startExists(id: SlotId): boolean {
  const { date, start } = parse(id);
  try {
    localDateTimeToUtc(date, start, THERAPIST_TIME_ZONE);
    return true;
  } catch (error) {
    if (error instanceof NonexistentLocalTimeError) return false;
    throw error;
  }
}

function format(parts: SlotIdParts): SlotId {
  const id = `${parts.date}T${parts.start}#${parts.type}`;
  check(id, parts);
  if (!startExists(id as SlotId)) {
    throw new InvalidSlotIdError(id, `start does not exist in ${THERAPIST_TIME_ZONE}`);
  }
  return id as SlotId;
}

function parse(input: string): SlotIdParts {
  const match = PATTERN.exec(input);
  if (!match) throw new InvalidSlotIdError(input, 'expected <yyyy-mm-dd>T<HH:mm>#<type>');
  const [, date = '', start = '', type = ''] = match;
  const parts = { date, start, type } as SlotIdParts;
  check(input, parts);
  return parts;
}

function of(input: string): SlotId {
  parse(input);
  return input as SlotId;
}

function is(input: string): input is SlotId {
  try {
    parse(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * `format` builds an id from parts, `parse` reads one, `of` brands a string, `is` tests one,
 * `startExists` checks that its start is a real Rome wall-clock time.
 */
export const SlotId = { format, parse, of, is, startExists } as const;
