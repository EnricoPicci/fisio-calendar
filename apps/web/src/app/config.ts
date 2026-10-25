import { LOCAL_AUTH_ISSUER } from '../services/local-auth-service';

/**
 * Build-time configuration (docs/architecture.md §7.1): which `AuthService` the bundle carries
 * and where it points. Read once in `main.tsx` from `import.meta.env` (`VITE_*`, see
 * `vite-env.d.ts`); the default is the local build against the `pnpm dev` emulator, the cloud
 * build (WP0.9) sets `VITE_AUTH=amplify` with the pool and app client ids. A production bundle
 * never defaults: without `VITE_AUTH` it would post sign-ins to the emulator's loopback address
 * on the user's device, so it is refused at start.
 */
export type AuthConfig =
  | { readonly mode: 'local'; readonly issuer: string }
  | { readonly mode: 'amplify'; readonly userPoolId: string; readonly userPoolClientId: string };

export interface WebConfig {
  readonly auth: AuthConfig;
}

export function readConfig(env: ImportMetaEnv): WebConfig {
  if (env.PROD && env.VITE_AUTH === undefined) {
    throw new Error('A production build needs VITE_AUTH ("local" or "amplify")');
  }
  const mode = env.VITE_AUTH ?? 'local';
  if (mode === 'local') {
    return { auth: { mode, issuer: env.VITE_AUTH_ISSUER ?? LOCAL_AUTH_ISSUER } };
  }
  if (mode === 'amplify') {
    const userPoolId = env.VITE_COGNITO_USER_POOL_ID;
    const userPoolClientId = env.VITE_COGNITO_CLIENT_ID;
    if (!userPoolId || !userPoolClientId) {
      throw new Error(
        'VITE_AUTH=amplify needs VITE_COGNITO_USER_POOL_ID and VITE_COGNITO_CLIENT_ID',
      );
    }
    return { auth: { mode, userPoolId, userPoolClientId } };
  }
  throw new Error(`Unknown VITE_AUTH "${String(mode)}": expected "local" or "amplify"`);
}
