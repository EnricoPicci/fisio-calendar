import type { SlotId } from '@fisio/domain';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BookingIdSchema,
  ClientIdSchema,
  EmailSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  LocalTimeSchema,
  PhoneE164Schema,
  RuleIdSchema,
  SlotIdSchema,
  SlotTypeSchema,
} from '../src/schemas';

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('Zod base schemas', () => {
  it('ids are UUIDs (Cognito sub for clients)', () => {
    const uuid = '3f1c9a52-7d4b-4e1a-9c2f-0b8e6d5a4c31';
    for (const schema of [ClientIdSchema, BookingIdSchema, RuleIdSchema]) {
      expect(ok(schema, uuid)).toBe(true);
      expect(ok(schema, 'not-a-uuid')).toBe(false);
      expect(ok(schema, '')).toBe(false);
      expect(ok(schema, 42)).toBe(false);
    }
  });

  it('phone numbers are E.164: + then 7 to 15 digits, no leading zero', () => {
    for (const valid of ['+393331234567', '+41791234567', '+1234567']) {
      expect(ok(PhoneE164Schema, valid)).toBe(true);
    }
    for (const invalid of [
      '3331234567',
      '+39 333 1234567',
      '+0391234567',
      '+123456',
      '+1234567890123456',
      '00393331234567',
      '+39-333-1234567',
    ]) {
      expect(ok(PhoneE164Schema, invalid)).toBe(false);
    }
  });

  it('emails are trimmed and lower-cased so one address is one client', () => {
    expect(EmailSchema.parse('  Mario.Rossi@Example.IT ')).toBe('mario.rossi@example.it');
    expect(ok(EmailSchema, 'mario.rossi')).toBe(false);
    expect(ok(EmailSchema, 'mario@')).toBe(false);
    expect(ok(EmailSchema, '')).toBe(false);
  });

  it('IsoDate accepts only real yyyy-mm-dd dates', () => {
    expect(ok(IsoDateSchema, '2028-02-29')).toBe(true);
    expect(ok(IsoDateSchema, '2027-02-29')).toBe(false);
    expect(ok(IsoDateSchema, '2027-13-01')).toBe(false);
    expect(ok(IsoDateSchema, '2027-03-28T00:00:00Z')).toBe(false);
  });

  it('LocalTime accepts HH:mm from 00:00 to 23:59', () => {
    expect(ok(LocalTimeSchema, '00:00')).toBe(true);
    expect(ok(LocalTimeSchema, '23:59')).toBe(true);
    expect(ok(LocalTimeSchema, '24:00')).toBe(false);
    expect(ok(LocalTimeSchema, '9:00')).toBe(false);
  });

  it('IsoDateTime accepts UTC instants only (Z suffix)', () => {
    expect(ok(IsoDateTimeSchema, '2027-03-28T07:00:00Z')).toBe(true);
    expect(ok(IsoDateTimeSchema, '2027-03-28T07:00:00.000Z')).toBe(true);
    expect(ok(IsoDateTimeSchema, '2027-03-28T09:00:00+02:00')).toBe(false);
    expect(ok(IsoDateTimeSchema, '2027-03-28')).toBe(false);
  });

  it('SlotType is studio or pool', () => {
    expect(SlotTypeSchema.options).toEqual(['studio', 'pool']);
    expect(ok(SlotTypeSchema, 'gym')).toBe(false);
  });

  it('SlotId delegates to the domain module and yields the branded type', () => {
    const parsed = SlotIdSchema.parse('2027-03-28T09:00#pool');
    expect(parsed).toBe('2027-03-28T09:00#pool');
    expectTypeOf(parsed).toEqualTypeOf<SlotId>();
    expect(ok(SlotIdSchema, '2027-02-30T09:00#pool')).toBe(false);
    expect(ok(SlotIdSchema, '2027-03-28T09:00#gym')).toBe(false);
    expect(ok(SlotIdSchema, 7)).toBe(false);
  });
});
