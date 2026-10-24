import { describe, expect, it, vi } from 'vitest';
import { FixedClock, systemClock } from '../src/clock';

describe('Clock: injectable source of the current instant', () => {
  it('FixedClock returns the instant it was given, as a fresh Date each call', () => {
    const clock = new FixedClock('2027-03-28T07:00:00.000Z');
    const a = clock.now();
    a.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe('2027-03-28T07:00:00.000Z');
  });

  it('FixedClock accepts a Date', () => {
    const clock = new FixedClock(new Date('2027-10-31T08:00:00Z'));
    expect(clock.now().toISOString()).toBe('2027-10-31T08:00:00.000Z');
  });

  it('set moves the clock to another instant', () => {
    const clock = new FixedClock('2027-01-01T00:00:00Z');
    clock.set('2027-06-01T12:00:00Z');
    expect(clock.now().toISOString()).toBe('2027-06-01T12:00:00.000Z');
  });

  it('advance adds elapsed time in days, hours, minutes, seconds', () => {
    const clock = new FixedClock('2027-03-27T23:00:00Z');
    clock.advance({ minutes: 10 });
    expect(clock.now().toISOString()).toBe('2027-03-27T23:10:00.000Z');
    clock.advance({ days: 1, hours: 2, seconds: 30 });
    expect(clock.now().toISOString()).toBe('2027-03-29T01:10:30.000Z');
  });

  it('refuses an invalid instant', () => {
    expect(() => new FixedClock('not a date')).toThrow(RangeError);
    expect(() => new FixedClock('2027-01-01T00:00:00Z').set('nope')).toThrow(RangeError);
  });

  it('advance refuses a non-finite elapsed time and keeps the current instant', () => {
    const clock = new FixedClock('2027-03-28T07:00:00Z');
    expect(() => clock.advance({ minutes: Number.NaN })).toThrow(RangeError);
    expect(() => clock.advance({ hours: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(clock.now().toISOString()).toBe('2027-03-28T07:00:00.000Z');
  });

  // Value: protects=now() never returns an Invalid Date after a huge advance; fails_when=advance only checks finiteness; why_new=the finite check lets 1e10 days through; seam=none; no_claim=dates before year 0
  it('advance refuses to leave the range a Date can hold', () => {
    const clock = new FixedClock('2027-03-28T07:00:00Z');
    expect(() => clock.advance({ days: 1e10 })).toThrow(RangeError);
    expect(() => clock.advance({ days: -1e10 })).toThrow(RangeError);
    expect(clock.now().toISOString()).toBe('2027-03-28T07:00:00.000Z');
  });

  // Value: protects=a spec's fixed instant is the same on every host; fails_when=a string without Z or offset is read in the host zone; why_new=all specs happened to write Z; seam=none; no_claim=offsets other than ±hh:mm
  it('refuses an instant string without Z or an offset, which would depend on the host zone', () => {
    expect(() => new FixedClock('2027-03-28T09:00:00')).toThrow(RangeError);
    expect(() => new FixedClock('2027-03-28')).toThrow(RangeError);
    expect(() => new FixedClock('2027-03-28T07:00:00Z').set('2027-03-28T09:00')).toThrow(
      RangeError,
    );
    expect(new FixedClock('2027-03-28T09:00:00+02:00').now().toISOString()).toBe(
      '2027-03-28T07:00:00.000Z',
    );
  });

  it('systemClock reads the current instant of the process clock', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2027-03-28T07:00:00Z'));
      expect(systemClock.now().toISOString()).toBe('2027-03-28T07:00:00.000Z');
      vi.advanceTimersByTime(60_000);
      expect(systemClock.now().toISOString()).toBe('2027-03-28T07:01:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});
