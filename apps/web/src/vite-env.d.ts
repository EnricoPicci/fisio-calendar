/// <reference types="vite/client" />

/**
 * Build-time configuration (docs/architecture.md §7.1: the `AuthService` is selected at build
 * time). Read only by `src/app/config.ts`; everything else receives the result through the
 * dependency context.
 */
interface ImportMetaEnv {
  /** `local` (the auth emulator, the default) or `amplify` (Cognito through Amplify Auth). */
  readonly VITE_AUTH?: 'local' | 'amplify';
  /** The auth emulator's issuer URL for the `local` service (default: the `pnpm dev` emulator). */
  readonly VITE_AUTH_ISSUER?: string;
  /** The Cognito pool and SPA app client for the `amplify` service. */
  readonly VITE_COGNITO_USER_POOL_ID?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
}
