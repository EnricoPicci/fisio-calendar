import { describe, expect, it } from 'vitest';
import { fakeJwt } from '../../test/support/jwt';
import { decodeJwtClaims } from './jwt';

describe('JWT claims, read without verification (architecture §8.2: the API verifies)', () => {
  it('returns the payload of a well-formed token', () => {
    expect(decodeJwtClaims(fakeJwt({ sub: 'x', role: 'client', exp: 42 }))).toEqual({
      sub: 'x',
      role: 'client',
      exp: 42,
    });
  });

  it('decodes UTF-8 in the payload (accented names in the ID token)', () => {
    expect(decodeJwtClaims(fakeJwt({ email: 'niccolò@example.it' }))).toEqual({
      email: 'niccolò@example.it',
    });
  });

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['one segment', 'abc'],
    ['empty payload', 'a..c'],
    ['not base64', 'a.!!!.c'],
    ['not JSON', `a.${btoa('{oops')}.c`],
    ['a JSON string', `a.${btoa('"str"')}.c`],
    ['a JSON array', `a.${btoa('[1]')}.c`],
    ['JSON null', `a.${btoa('null')}.c`],
  ])('answers {} for %s', (_label, token) => {
    expect(decodeJwtClaims(token)).toEqual({});
  });
});
