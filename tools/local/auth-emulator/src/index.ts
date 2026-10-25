// The local auth emulator (docs/architecture.md §11.4): Cognito's part of the local stack.
export {
  DEFAULT_EMULATOR_CONFIG,
  type EmulatorConfig,
  LOCAL_EMULATOR_PORT,
  LOCAL_POOL_ID,
  LOCAL_SETUP_URL,
  LOCAL_WEB_ORIGINS,
  MS_PER_DAY,
} from './config';
export {
  AuthEmulator,
  type AuthEmulatorDeps,
  AuthError,
  type AuthTokens,
  type Challenge,
  type SignInStep,
  type TotpEnrolment,
} from './emulator';
export { LocalIdentityProvider } from './identity-provider';
export { type PublicJwk, RsaSigner } from './jwt';
export { createEmulatorApp, createLocalEmulator } from './server';
export { EmulatorStore } from './store';
