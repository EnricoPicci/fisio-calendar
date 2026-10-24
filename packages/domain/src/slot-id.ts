import { isIsoDate, isLocalTime } from './time';

/**
 * Slot identity (docs/architecture.md §3.2, §5.1, decision 14A): `<date>T<HH:mm>#<type>`,
 * e.g. `2027-03-28T09:00#pool`. Unique within the therapist; date and start are local
 * (Europe/Rome) wall-clock values. This module is the only place that builds or reads one;
 * repository keys derive from it. Ids of one type sort chronologically as plain strings.
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

function format(parts: SlotIdParts): SlotId {
  const id = `${parts.date}T${parts.start}#${parts.type}`;
  check(id, parts);
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

/** `format` builds an id from parts, `parse` reads one, `of` brands a string, `is` tests one. */
export const SlotId = { format, parse, of, is } as const;
