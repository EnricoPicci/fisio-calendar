import { describe, expect, it } from 'vitest';
import { LOCAL_AUTH_ISSUER } from '../services/local-auth-service';
import { readConfig } from './config';

describe('Build-time configuration (architecture §7.1: AuthService selected at build time)', () => {
  it('defaults to the local auth emulator of pnpm dev', () => {
    expect(readConfig({} as ImportMetaEnv)).toEqual({
      auth: { mode: 'local', issuer: LOCAL_AUTH_ISSUER },
    });
  });

  it('the local issuer can be overridden', () => {
    expect(
      readConfig({
        VITE_AUTH: 'local',
        VITE_AUTH_ISSUER: 'http://127.0.0.1:9200/x',
      } as ImportMetaEnv).auth,
    ).toEqual({ mode: 'local', issuer: 'http://127.0.0.1:9200/x' });
  });

  it('the Amplify service needs the pool and the app client', () => {
    expect(
      readConfig({
        VITE_AUTH: 'amplify',
        VITE_COGNITO_USER_POOL_ID: 'eu-central-1_abc',
        VITE_COGNITO_CLIENT_ID: 'client',
      } as ImportMetaEnv).auth,
    ).toEqual({ mode: 'amplify', userPoolId: 'eu-central-1_abc', userPoolClientId: 'client' });
    expect(() => readConfig({ VITE_AUTH: 'amplify' } as ImportMetaEnv)).toThrow(/VITE_COGNITO/);
  });

  it('an unknown mode is refused', () => {
    expect(() => readConfig({ VITE_AUTH: 'cognito' } as unknown as ImportMetaEnv)).toThrow(
      /VITE_AUTH/,
    );
  });
});
