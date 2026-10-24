// Value: protects=the @fisio/contracts entry point exposes errors, schemas and the Italian strings as stringsIt; fails_when=a re-export or the stringsIt rename is dropped from src/index.ts; why_new=specs import modules directly, nothing reads the barrel; seam=none; no_claim=string wording
import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index';
import { strings } from '../src/strings/it';

describe('@fisio/contracts public entry point', () => {
  it('exposes the error catalogue, the base schemas and the Italian strings as stringsIt', () => {
    expect(contracts.problemTypeOf('slot_full')).toBe('urn:fisio:error:slot_full');
    expect(contracts.SlotIdSchema.safeParse('2027-03-28T09:00#pool').success).toBe(true);
    expect(contracts.stringsIt).toBe(strings);
  });

  it('the SPA can map a problem+json type to its Italian message through the entry point', () => {
    const code = contracts.errorCodeFromProblemType('urn:fisio:error:cutoff_passed');
    expect(code).toBe('cutoff_passed');
    expect(code && contracts.stringsIt.errors[code]).toBe(strings.errors.cutoff_passed);
  });
});
