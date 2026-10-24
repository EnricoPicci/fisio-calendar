import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  InvalidTimeZoneError,
  isIsoDate,
  isLocalTime,
  localDateOf,
  localDateTimeToUtc,
  localTimeOf,
  localWeekday,
  MAX_YEAR,
  MIN_YEAR,
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

  // Value: protects=DST resolution is the same on a laptop in Rome and a Lambda in UTC; fails_when=the conversion consults the host time zone (it did: CI on UTC picked 01:30Z for the fall-back hour); why_new=specs ran only under the developer's own zone; seam=none; no_claim=zones without Intl data
  it('gives the same instants whatever the host time zone is', () => {
    const original = process.env.TZ;
    // Minutes behind UTC on 2027-01-01, as Date#getTimezoneOffset reports them.
    const januaryOffset = {
      UTC: 0,
      'Europe/Rome': -60,
      'America/New_York': 300,
      'Asia/Tokyo': -540,
    };
    try {
      for (const [host, offset] of Object.entries(januaryOffset)) {
        process.env.TZ = host;
        // The switch took effect, so the rows below really ran under this host zone.
        expect(new Date(2027, 0, 1).getTimezoneOffset(), host).toBe(offset);
        expect(utc('2027-10-31', '02:30'), host).toBe('2027-10-31T00:30:00.000Z');
        expect(utc('2027-03-28', '09:00'), host).toBe('2027-03-28T07:00:00.000Z');
        expect(utc('2027-10-31', '09:00'), host).toBe('2027-10-31T08:00:00.000Z');
        expect(() => localDateTimeToUtc('2027-03-28', '02:30'), host).toThrow(
          NonexistentLocalTimeError,
        );
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('resolves an ambiguous fall-back time to its first occurrence (02:30 CEST on 2027-10-31)', () => {
    expect(utc('2027-10-31', '02:30')).toBe('2027-10-31T00:30:00.000Z');
    // The edges of the repeated hour: 02:00–02:59 happen twice, 01:59 and 03:00 once.
    expect(utc('2027-10-31', '01:59')).toBe('2027-10-30T23:59:00.000Z');
    expect(utc('2027-10-31', '02:00')).toBe('2027-10-31T00:00:00.000Z');
    expect(utc('2027-10-31', '02:59')).toBe('2027-10-31T00:59:00.000Z');
    expect(utc('2027-10-31', '03:00')).toBe('2027-10-31T02:00:00.000Z');
    // Same rule in a zone west of UTC: New York repeats 01:00–01:59 on 2027-11-07.
    expect(localDateTimeToUtc('2027-11-07', '01:30', 'America/New_York').toISOString()).toBe(
      '2027-11-07T05:30:00.000Z',
    );
  });

  // Value: protects=a misspelled or made-up zone fails at once with its own error; fails_when=the zone reaches tzOffset unchecked ('Foo+05' read as UTC+5); why_new=only real zones were passed; seam=none; no_claim=which IANA names the runtime ships
  it('refuses an unknown time zone instead of guessing an offset', () => {
    for (const zone of ['Europe/Rme', 'Foo+05', '']) {
      expect(() => localDateTimeToUtc('2027-03-28', '09:00', zone), zone).toThrow(
        InvalidTimeZoneError,
      );
      expect(() => localDateOf(new Date('2027-03-28T07:00:00Z'), zone), zone).toThrow(
        InvalidTimeZoneError,
      );
      expect(() => localTimeOf(new Date('2027-03-28T07:00:00Z'), zone), zone).toThrow(
        InvalidTimeZoneError,
      );
    }
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

  // Value: protects=addLocalDays only returns dates the other helpers accept; fails_when=fractional days or a result outside the supported years comes back as a string; why_new=only valid steps were covered; seam=none; no_claim=performance of large steps
  it('addLocalDays refuses fractional days and results outside the supported years', () => {
    expect(() => addLocalDays('2027-03-28', 0.5)).toThrow(RangeError);
    expect(() => addLocalDays('2027-03-28', Number.NaN)).toThrow(RangeError);
    expect(() => addLocalDays(`${MIN_YEAR}-01-01`, -1)).toThrow(RangeError);
    expect(() => addLocalDays(`${MAX_YEAR}-12-31`, 1)).toThrow(RangeError);
    expect(() => addLocalDays('2027-03-28', 1e9)).toThrow(RangeError);
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

  // Value: protects=dates before 1900 (local mean time, fractional-minute offsets) never reach the tz math; fails_when=the year floor is dropped; why_new=no spec used an early year; seam=none; no_claim=historical tz accuracy after 1900
  it('isIsoDate accepts only the supported years, 1900 to 9999', () => {
    expect([MIN_YEAR, MAX_YEAR]).toEqual([1900, 9999]);
    expect(isIsoDate('1900-01-01')).toBe(true);
    expect(isIsoDate('1899-12-31')).toBe(false);
    expect(isIsoDate('0050-06-15')).toBe(false);
    expect(isIsoDate('9999-12-31')).toBe(true);
    expect(() => localDateTimeToUtc('1890-06-01', '12:00')).toThrow(RangeError);
  });

  it('isLocalTime accepts only HH:mm from 00:00 to 23:59', () => {
    expect(isLocalTime('00:00')).toBe(true);
    expect(isLocalTime('23:59')).toBe(true);
    expect(isLocalTime('24:00')).toBe(false);
    expect(isLocalTime('9:00')).toBe(false);
    expect(isLocalTime('09:00:00')).toBe(false);
  });
});
