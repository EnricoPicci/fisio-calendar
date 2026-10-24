import { describe, expect, it } from 'vitest';
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

  it('systemClock reads the real time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
