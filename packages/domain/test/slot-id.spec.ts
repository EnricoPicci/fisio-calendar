import { describe, expect, it } from 'vitest';
import { InvalidSlotIdError, SlotId } from '../src/slot-id';

describe('SlotId: identity of a slot (<date>T<HH:mm>#<type>)', () => {
  it('formats parts into the canonical id', () => {
    expect(SlotId.format({ date: '2027-03-28', start: '09:00', type: 'pool' })).toBe(
      '2027-03-28T09:00#pool',
    );
  });

  it('round-trips: parse(format(parts)) equals parts and format(parse(id)) equals id', () => {
    const parts = { date: '2027-10-31', start: '18:30', type: 'studio' } as const;
    const id = SlotId.format(parts);
    expect(SlotId.parse(id)).toEqual(parts);
    expect(SlotId.format(SlotId.parse(id))).toBe(id);
  });

  it('accepts the day boundaries 00:00 and 23:59 and leap days', () => {
    for (const raw of [
      '2027-01-01T00:00#studio',
      '2027-12-31T23:59#pool',
      '2028-02-29T12:00#pool',
    ]) {
      expect(SlotId.is(raw)).toBe(true);
      expect(SlotId.of(raw)).toBe(raw);
    }
  });

  it.each([
    ['empty string', ''],
    ['missing type', '2027-03-28T09:00'],
    ['unknown type', '2027-03-28T09:00#gym'],
    ['uppercase type', '2027-03-28T09:00#POOL'],
    ['lowercase t separator', '2027-03-28t09:00#pool'],
    ['space separator', '2027-03-28 09:00#pool'],
    ['single-digit hour', '2027-03-28T9:00#pool'],
    ['hour 24', '2027-03-28T24:00#pool'],
    ['minute 60', '2027-03-28T09:60#pool'],
    ['seconds present', '2027-03-28T09:00:00#pool'],
    ['month 13', '2027-13-01T09:00#pool'],
    ['day 0', '2027-03-00T09:00#pool'],
    ['impossible calendar date', '2027-02-30T09:00#pool'],
    ['29 February in a common year', '2027-02-29T09:00#pool'],
    ['leading whitespace', ' 2027-03-28T09:00#pool'],
    ['trailing whitespace', '2027-03-28T09:00#pool '],
    ['trailing newline', '2027-03-28T09:00#pool\n'],
    ['two-digit year', '27-03-28T09:00#pool'],
  ])('rejects %s', (_label, raw) => {
    expect(SlotId.is(raw)).toBe(false);
    expect(() => SlotId.parse(raw)).toThrow(InvalidSlotIdError);
    expect(() => SlotId.of(raw)).toThrow(InvalidSlotIdError);
  });

  it('rejects invalid parts on format instead of building a bad id', () => {
    expect(() => SlotId.format({ date: '2027-02-30', start: '09:00', type: 'pool' })).toThrow(
      InvalidSlotIdError,
    );
    expect(() => SlotId.format({ date: '2027-03-28', start: '9:00', type: 'pool' })).toThrow(
      InvalidSlotIdError,
    );
    expect(() =>
      // @ts-expect-error: an unknown type must be refused at runtime too
      SlotId.format({ date: '2027-03-28', start: '09:00', type: 'gym' }),
    ).toThrow(InvalidSlotIdError);
  });

  it('the error names the rejected input', () => {
    expect(() => SlotId.parse('nope')).toThrow(/"nope"/);
  });

  it('ids of the same type sort chronologically as plain strings', () => {
    const ids = [
      '2027-03-28T18:00#pool',
      '2027-03-27T09:00#pool',
      '2027-03-28T09:00#pool',
      '2027-03-28T08:30#pool',
    ];
    expect([...ids].sort()).toEqual([
      '2027-03-27T09:00#pool',
      '2027-03-28T08:30#pool',
      '2027-03-28T09:00#pool',
      '2027-03-28T18:00#pool',
    ]);
  });
});
