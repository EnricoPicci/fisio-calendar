import { AuthError, type AuthTokens } from './auth-service';

/**
 * The pure part of the Amplify service, testable without `aws-amplify`: Cognito's exception
 * names onto `AuthErrorCode` (D28), and the token pair out of an Amplify session.
 */

/** Cognito exception names → `AuthErrorCode`; anything else stays unexpected. */
export function mapAmplifyError(error: unknown): unknown {
  if (error instanceof AuthError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  switch (name) {
    case 'CodeMismatchException':
    case 'EnableSoftwareTokenMFAException':
      return new AuthError('code_mismatch', { cause: error });
    case 'ExpiredCodeException':
      return new AuthError('code_expired', { cause: error });
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException':
    case 'LimitExceededException':
      return new AuthError('too_many_attempts', { cause: error });
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
    case 'UserNotConfirmedException':
    case 'PasswordResetRequiredException':
      return new AuthError('not_authorized', { cause: error });
    case 'InvalidPasswordException':
      return new AuthError('invalid_password', { cause: error });
    default:
      return error;
  }
}

export interface AmplifySessionTokens {
  readonly accessToken: { toString(): string };
  readonly idToken?: { toString(): string };
}

/** Both tokens of an Amplify session, or null when there is no signed-in user. */
export function tokensOf(tokens: AmplifySessionTokens | undefined): AuthTokens | null {
  if (!tokens?.idToken) return null;
  return { accessToken: tokens.accessToken.toString(), idToken: tokens.idToken.toString() };
}
