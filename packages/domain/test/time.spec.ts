import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  isIsoDate,
  isLocalTime,
  localDateOf,
  localDateTimeToUtc,
  localTimeOf,
  localWeekday,
  NonexistentLocalTimeError,
  THERAPIST_TIME_ZONE,
} from '../src/time';

const utc = (date: string, time: string) => localDateTimeToUtc(date, time).toISOString();

describe('S1 Slot generation: time helpers in Europe/Rome', () => {
  it('the therapist time zone is Europe/Rome', () => {
    expect(THERAPIST_TIME_ZONE).toBe('Europe/Rome');
  });

  it('DST Sundays (March, October) keep local start times', () => {
    // Spring forward on 2027-03-28: CET (+01:00) before, CEST (+02:00) after.
    expect(utc('2027-03-27', '09:00')).toBe('2027-03-27T08:00:00.000Z');
    expect(utc('2027-03-28', '09:00')).toBe('2027-03-28T07:00:00.000Z');
    // Fall back on 2027-10-31: CEST before, CET after.
    expect(utc('2027-10-30', '09:00')).toBe('2027-10-30T07:00:00.000Z');
    expect(utc('2027-10-31', '09:00')).toBe('2027-10-31T08:00:00.000Z');
    // And back again: the stored instant reads as the same local wall-clock time.
    for (const [date, time] of [
      ['2027-03-27', '09:00'],
      ['2027-03-28', '09:00'],
      ['2027-10-30', '09:00'],
      ['2027-10-31', '09:00'],
    ] as const) {
      const instant = localDateTimeToUtc(date, time);
      expect(localDateOf(instant)).toBe(date);
      expect(localTimeOf(instant)).toBe(time);
    }
  });

  it('refuses a local time inside the spring-forward gap (02:30 on 2027-03-28 does not exist)', () => {
    expect(() => localDateTimeToUtc('2027-03-28', '02:30')).toThrow(NonexistentLocalTimeError);
    expect(utc('2027-03-28', '01:59')).toBe('2027-03-28T00:59:00.000Z');
    expect(utc('2027-03-28', '03:00')).toBe('2027-03-28T01:00:00.000Z');
  });

  it('resolves an ambiguous fall-back time to its first occurrence (02:30 CEST on 2027-10-31)', () => {
    expect(utc('2027-10-31', '02:30')).toBe('2027-10-31T00:30:00.000Z');
  });

  it('refuses malformed dates and times as malformed, not as a daylight saving gap', () => {
    for (const [date, time] of [
      ['2027-02-30', '09:00'],
      ['2027-03-28', '24:00'],
      ['2027-03-28', '9:00'],
      ['2027-03-28', '09:60'],
    ] as const) {
      let error: unknown;
      try {
        localDateTimeToUtc(date, time);
      } catch (e) {
        error = e;
      }
      expect(error, `${date} ${time}`).toBeInstanceOf(RangeError);
      expect(error, `${date} ${time}`).not.toBeInstanceOf(NonexistentLocalTimeError);
    }
  });

  it('localDateOf and localTimeOf read the Rome wall clock, not UTC', () => {
    const lateUtc = new Date('2027-03-27T23:30:00Z');
    expect(localDateOf(lateUtc)).toBe('2027-03-28');
    expect(localTimeOf(lateUtc)).toBe('00:30');
    expect(localDateOf(new Date('2027-07-15T21:59:00Z'))).toBe('2027-07-15');
    expect(localDateOf(new Date('2027-07-15T22:00:00Z'))).toBe('2027-07-16');
  });

  it('addLocalDays steps calendar days across month, year and DST boundaries', () => {
    expect(addLocalDays('2027-03-27', 1)).toBe('2027-03-28');
    expect(addLocalDays('2027-03-28', 1)).toBe('2027-03-29');
    expect(addLocalDays('2027-10-31', -1)).toBe('2027-10-30');
    expect(addLocalDays('2027-12-31', 1)).toBe('2028-01-01');
    expect(addLocalDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addLocalDays('2027-01-01', 0)).toBe('2027-01-01');
    expect(() => addLocalDays('2027-02-30', 1)).toThrow(RangeError);
  });

  it('localWeekday is the ISO weekday, Monday = 1 … Sunday = 7', () => {
    expect(localWeekday('2027-03-28')).toBe(7);
    expect(localWeekday('2027-03-29')).toBe(1);
    expect(localWeekday('2027-10-30')).toBe(6);
  });

  // Value: protects=localWeekday refuses an impossible date instead of naming a weekday; fails_when=it parses the string without the real-date check (2027-02-30 -> March 2); why_new=only addLocalDays/localDateTimeToUtc error paths are covered; seam=none; no_claim=other malformed formats
  it('localWeekday refuses a date that does not exist', () => {
    expect(() => localWeekday('2027-02-30')).toThrow(RangeError);
    expect(() => localWeekday('2027-3-28')).toThrow(RangeError);
  });

  // Value: protects=the timeZone argument of the conversion helpers is honoured, not silently Rome; fails_when=a helper drops or ignores its timeZone parameter; why_new=every existing case uses the default zone; seam=none; no_claim=zones other than UTC and New York
  it('honours an explicit time zone instead of the therapist default', () => {
    expect(localDateTimeToUtc('2027-03-28', '09:00', 'UTC').toISOString()).toBe(
      '2027-03-28T09:00:00.000Z',
    );
    const instant = new Date('2027-03-27T23:30:00Z');
    expect(localDateOf(instant, 'UTC')).toBe('2027-03-27');
    expect(localTimeOf(instant, 'UTC')).toBe('23:30');
    // New York springs forward on 2027-03-14, two weeks before Rome.
    expect(() => localDateTimeToUtc('2027-03-14', '02:30', 'America/New_York')).toThrow(
      NonexistentLocalTimeError,
    );
    expect(localDateTimeToUtc('2027-03-28', '02:30', 'America/New_York').toISOString()).toBe(
      '2027-03-28T06:30:00.000Z',
    );
  });

  it('isIsoDate accepts only real calendar dates in yyyy-mm-dd', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2027-02-29')).toBe(false);
    expect(isIsoDate('2027-2-1')).toBe(false);
    expect(isIsoDate('2027-01-01T00:00')).toBe(false);
  });

  it('isLocalTime accepts only HH:mm from 00:00 to 23:59', () => {
    expect(isLocalTime('00:00')).toBe(true);
    expect(isLocalTime('23:59')).toBe(true);
    expect(isLocalTime('24:00')).toBe(false);
    expect(isLocalTime('9:00')).toBe(false);
    expect(isLocalTime('09:00:00')).toBe(false);
  });
});
