// Identity (docs/architecture.md §8): access-token verification and the `IdentityProvider` port's
// Cognito adapter. Exported for the bootstrap CLI (tools/bootstrap), which uses the same port.
export { type CognitoClient, CognitoIdentityProvider } from './cognito-identity-provider';
export {
  type AccessTokenClaims,
  createTokenVerifier,
  fetchJwks,
  InvalidTokenError,
  type TokenVerifier,
} from './token-verifier';
