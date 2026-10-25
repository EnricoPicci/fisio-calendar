import './styles.css';
import { stringsIt } from '@fisio/contracts';
import { systemClock } from '@fisio/domain';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ALERT, BUTTON } from './app/classes';
import { type AuthConfig, readConfig } from './app/config';
import { DepsProvider } from './app/deps';
import { OpenApiClient } from './services/api-client';
import type { AuthService } from './services/auth-service';
import { LocalAuthService } from './services/local-auth-service';
import { BrowserStorage, MemoryStorage, type Storage } from './services/storage';
import { SessionViewModel } from './viewmodels/SessionViewModel';

/**
 * The composition root of the SPA (docs/architecture.md §7.1): services built once from the
 * build-time configuration, one session for the app, the typed API client on the same origin
 * (`/api/v1`, proxied by Vite locally and by CloudFront in the cloud), then React. The loading
 * page is painted before the auth service loads, so the cloud build's Amplify chunk never gates
 * the first paint; a bootstrap that fails (a chunk that cannot load, a bad configuration) shows
 * the error text with a retry instead of the loading page forever.
 */
const API_BASE_URL = '/api/v1';

const browserFetch: typeof fetch = (input, init) => fetch(input, init);

/** `localStorage`, or memory where the browser blocks site storage (the session then lasts a tab). */
function deviceStorage(): Storage {
  try {
    const probe = 'fisio.storage.probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return new BrowserStorage(localStorage);
  } catch {
    return new MemoryStorage();
  }
}

async function createAuthService(config: AuthConfig): Promise<AuthService> {
  if (config.mode === 'amplify') {
    // Loaded only by the cloud build, so the local bundle carries no Amplify code.
    const amplify = await import('./services/amplify-auth-service');
    amplify.configureAmplify(config);
    return new amplify.AmplifyAuthService();
  }
  return new LocalAuthService({
    issuer: config.issuer,
    fetch: browserFetch,
    storage: deviceStorage(),
  });
}

const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root element');
const root = createRoot(container);
root.render(
  <main className="mx-auto max-w-lg p-6" aria-busy="true">
    <p role="status" className="text-stone-500">
      {stringsIt.common.loading}
    </p>
  </main>,
);

try {
  const config = readConfig(import.meta.env);
  const auth = await createAuthService(config.auth);
  const session = new SessionViewModel(auth, systemClock);
  const api = new OpenApiClient({
    fetch: browserFetch,
    baseUrl: API_BASE_URL,
    accessToken$: session.accessToken$,
  });
  void session.restore();

  root.render(
    <DepsProvider deps={{ api, auth, session, strings: stringsIt, clock: systemClock }}>
      <App />
    </DepsProvider>,
  );
} catch (error) {
  console.error('[main] the app could not start', error);
  root.render(
    <main className="mx-auto max-w-lg p-6">
      <p role="alert" className={ALERT}>
        {stringsIt.common.unexpectedError}
      </p>
      <button type="button" className={`mt-4 ${BUTTON}`} onClick={() => window.location.reload()}>
        {stringsIt.common.retry}
      </button>
    </main>,
  );
}
