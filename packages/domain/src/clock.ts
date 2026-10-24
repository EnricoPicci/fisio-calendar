/**
 * The current instant, injected everywhere (docs/architecture.md §5.5) so specs run at a fixed
 * time and journeys can move time forward.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface Elapsed {
  readonly days?: number;
  readonly hours?: number;
  readonly minutes?: number;
  readonly seconds?: number;
}

/** A clock that stands still until a spec moves it. */
export class FixedClock implements Clock {
  #epochMs: number;

  constructor(instant: Date | string) {
    this.#epochMs = toEpochMs(instant);
  }

  now(): Date {
    return new Date(this.#epochMs);
  }

  set(instant: Date | string): void {
    this.#epochMs = toEpochMs(instant);
  }

  advance({ days = 0, hours = 0, minutes = 0, seconds = 0 }: Elapsed): void {
    const next = this.#epochMs + (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
    if (!Number.isFinite(next)) throw new RangeError('Elapsed time must be a finite number');
    if (Math.abs(next) > MAX_EPOCH_MS) throw new RangeError('Elapsed time leaves the Date range');
    this.#epochMs = next;
  }
}

/** The largest instant a `Date` can hold, ±100,000,000 days from the epoch. */
const MAX_EPOCH_MS = 8.64e15;
/** A string instant must name its offset; without one, `Date` reads it in the host's zone. */
const EXPLICIT_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

function toEpochMs(instant: Date | string): number {
  if (typeof instant === 'string' && !EXPLICIT_OFFSET.test(instant)) {
    throw new RangeError(`Instant "${instant}" must end in Z or an offset such as +01:00`);
  }
  const ms = new Date(instant).getTime();
  if (Number.isNaN(ms)) throw new RangeError(`Invalid instant "${String(instant)}"`);
  return ms;
}
