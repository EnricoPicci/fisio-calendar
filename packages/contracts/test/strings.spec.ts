import { describe, expect, it } from 'vitest';
import { AUTH_ERROR_CODES } from '../src/auth';
import { ERROR_CODES } from '../src/errors';
import { strings } from '../src/strings/it';

describe('Italian strings module (architecture §7.3)', () => {
  it('has a message for every catalogued error code', () => {
    expect(Object.keys(strings.errors).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('has a message for every sign-in failure code', () => {
    expect(Object.keys(strings.auth.errors).sort()).toEqual([...AUTH_ERROR_CODES].sort());
  });

  it('no string is empty or untrimmed', () => {
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') {
        expect(value.trim(), path).toBe(value);
        expect(value.length, path).toBeGreaterThan(0);
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
      }
    };
    walk(strings, 'it');
  });
});
