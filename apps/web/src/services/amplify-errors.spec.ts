import { describe, expect, it } from 'vitest';
import { mapAmplifyError, tokensOf } from './amplify-errors';
import { AuthError } from './auth-service';

describe('Cognito exceptions onto AuthErrorCode (architecture D28, Amplify service)', () => {
  it.each([
    ['CodeMismatchException', 'code_mismatch'],
    ['EnableSoftwareTokenMFAException', 'code_mismatch'],
    ['ExpiredCodeException', 'code_expired'],
    ['TooManyRequestsException', 'too_many_attempts'],
    ['TooManyFailedAttemptsException', 'too_many_attempts'],
    ['LimitExceededException', 'too_many_attempts'],
    ['NotAuthorizedException', 'not_authorized'],
    ['UserNotFoundException', 'not_authorized'],
    ['UserNotConfirmedException', 'not_authorized'],
    ['PasswordResetRequiredException', 'not_authorized'],
    ['InvalidPasswordException', 'invalid_password'],
  ])('%s → %s, keeping the exception as the cause', (name, code) => {
    const cause = Object.assign(new Error(name), { name });
    const mapped = mapAmplifyError(cause);
    expect(mapped).toBeInstanceOf(AuthError);
    expect(mapped).toMatchObject({ code, cause });
  });

  it('an AuthError passes through unchanged', () => {
    const error = new AuthError('invalid_session');
    expect(mapAmplifyError(error)).toBe(error);
  });

  it('an unknown exception, a plain error and a non-error pass through unchanged', () => {
    const unknown = Object.assign(new Error('x'), { name: 'ResourceNotFoundException' });
    expect(mapAmplifyError(unknown)).toBe(unknown);
    const plain = new Error('boom');
    expect(mapAmplifyError(plain)).toBe(plain);
    expect(mapAmplifyError(null)).toBeNull();
  });

  it('tokensOf: both tokens of a session, null without a signed-in user or an ID token', () => {
    expect(
      tokensOf({ accessToken: { toString: () => 'a' }, idToken: { toString: () => 'i' } }),
    ).toEqual({ accessToken: 'a', idToken: 'i' });
    expect(tokensOf({ accessToken: { toString: () => 'a' } })).toBeNull();
    expect(tokensOf(undefined)).toBeNull();
  });
});
