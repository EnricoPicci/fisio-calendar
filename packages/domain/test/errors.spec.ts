import { describe, expect, it } from 'vitest';
import { errorName, isErrorNamed } from '../src/errors';
import { InvalidSlotIdError } from '../src/slot-id';
import { InvalidLocalValueError, localDateTimeToUtc } from '../src/time';

describe('Recognising domain errors by name (TODOS.md: two copies of @fisio/domain)', () => {
  // Value: protects=an error from another copy of the module is recognised, and odd thrown values never make the check throw; fails_when=isErrorNamed falls back to instanceof or reads name without a guard; why_new=the helper is new, shared by classifyError and the API mapper; seam=none; no_claim=bundler behaviour
  it('matches on the name each error class sets, and tolerates any thrown value', () => {
    expect(isErrorNamed(new InvalidSlotIdError('x', 'bad'), 'InvalidSlotIdError')).toBe(true);
    const foreign = Object.assign(new Error('copy'), { name: 'InvalidSlotIdError' });
    expect(isErrorNamed(foreign, 'InvalidSlotIdError')).toBe(true);
    const hostile = Object.defineProperty({}, 'name', {
      get() {
        throw new Error('no');
      },
    });
    for (const value of [undefined, null, 'InvalidSlotIdError', 42, hostile]) {
      expect(isErrorNamed(value, 'InvalidSlotIdError')).toBe(false);
    }
    expect(errorName({ name: 7 })).toBeUndefined();
  });

  // Value: protects=malformed date and time input to the time helpers is a named error the API maps to 400, while it stays a RangeError for existing callers; fails_when=the helpers go back to a plain RangeError (a 500); why_new=named in WP0.4; seam=none; no_claim=other RangeErrors (programming errors stay 500)
  it('malformed local dates and times throw InvalidLocalValueError, a RangeError', () => {
    expect(() => localDateTimeToUtc('2027-02-30', '09:00')).toThrow(InvalidLocalValueError);
    expect(() => localDateTimeToUtc('2027-03-28', '9:00')).toThrow(InvalidLocalValueError);
    expect(() => localDateTimeToUtc('2027-03-28', '9:00')).toThrow(RangeError);
  });
});
