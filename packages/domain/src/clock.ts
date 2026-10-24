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
    this.#epochMs += (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  }
}

function toEpochMs(instant: Date | string): number {
  const ms = new Date(instant).getTime();
  if (Number.isNaN(ms)) throw new RangeError(`Invalid instant "${String(instant)}"`);
  return ms;
}
