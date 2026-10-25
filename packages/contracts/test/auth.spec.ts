import { describe, expect, it } from 'vitest';
import { AUTH_ERROR_CODES, DEFAULT_TENANT_ID, isAuthErrorCode } from '../src/auth';
import { ERROR_CODES } from '../src/errors';
import { TenantIdSchema } from '../src/schemas';

describe('Auth error codes: the sign-in failures both AuthService implementations map to', () => {
  // Value: protects=the C1/T1 sign-in failures have one code list that never collides with API codes; fails_when=a code is renamed in one place or shadows an ErrorCode; why_new=first auth code list; seam=none; no_claim=which flow raises which code (emulator specs)
  it('names the C1 and T1 failures and shares no code with the API error catalogue', () => {
    expect(AUTH_ERROR_CODES).toEqual(
      expect.arrayContaining(['code_mismatch', 'code_expired', 'too_many_attempts']),
    );
    const apiCodes: readonly string[] = ERROR_CODES;
    expect(AUTH_ERROR_CODES.filter((code) => apiCodes.includes(code))).toEqual([]);
    expect(isAuthErrorCode('code_expired')).toBe(true);
    expect(isAuthErrorCode('toString')).toBe(false);
  });

  // Value: protects=the default tenant id can be a key prefix and a token claim; fails_when=it gains a character TenantIdSchema refuses; why_new=new constant; seam=none; no_claim=multi-tenancy
  it('the default tenant id is a valid tenant id', () => {
    expect(TenantIdSchema.safeParse(DEFAULT_TENANT_ID).success).toBe(true);
  });
});
