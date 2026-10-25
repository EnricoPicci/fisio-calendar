import { AuthError, type AuthTokens } from './auth-service';
import { NetworkError } from './network-error';

/**
 * The pure part of the Amplify service, testable without `aws-amplify`: Cognito's exception
 * names onto `AuthErrorCode` (D28), Amplify's own network failure onto the SPA's
 * `NetworkError`, and the token pair out of an Amplify session.
 */

/** Amplify signals a request that never reached Cognito with this exception name. */
const AMPLIFY_NETWORK_ERROR = 'NetworkError';
/** Thrown by `signIn` while Amplify still holds a user: the caller signs out and retries. */
const ALREADY_AUTHENTICATED = 'UserAlreadyAuthenticatedException';

export function isAlreadyAuthenticated(error: unknown): boolean {
  return nameOf(error) === ALREADY_AUTHENTICATED;
}

/** Cognito exception names → `AuthErrorCode`; a network failure → `NetworkError`; else unchanged. */
export function mapAmplifyError(error: unknown): unknown {
  if (error instanceof AuthError || error instanceof NetworkError) return error;
  switch (nameOf(error)) {
    case AMPLIFY_NETWORK_ERROR:
      return new NetworkError(error);
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
    case 'TokenRevokedException':
    case 'RefreshTokenReuseException':
    case 'UserLambdaValidationException':
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

function nameOf(error: unknown): unknown {
  return (error as { name?: unknown } | null)?.name;
}
