import './styles.css';
import { stringsIt } from '@fisio/contracts';
import { systemClock } from '@fisio/domain';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { type AuthConfig, readConfig } from './app/config';
import { DepsProvider } from './app/deps';
import { OpenApiClient } from './services/api-client';
import type { AuthService } from './services/auth-service';
import { LocalAuthService } from './services/local-auth-service';
import { BrowserStorage } from './services/storage';
import { SessionViewModel } from './viewmodels/SessionViewModel';

/**
 * The composition root of the SPA (docs/architecture.md §7.1): services built once from the
 * build-time configuration, one session for the app, the typed API client on the same origin
 * (`/api/v1`, proxied by Vite locally and by CloudFront in the cloud), then React.
 */
const API_BASE_URL = '/api/v1';

const browserFetch: typeof fetch = (input, init) => fetch(input, init);

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
    storage: new BrowserStorage(localStorage),
  });
}

const config = readConfig(import.meta.env);
const auth = await createAuthService(config.auth);
const session = new SessionViewModel(auth, systemClock);
const api = new OpenApiClient({
  fetch: browserFetch,
  baseUrl: API_BASE_URL,
  accessToken$: session.accessToken$,
});
void session.restore();

const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root element');
createRoot(container).render(
  <DepsProvider deps={{ api, auth, session, strings: stringsIt, clock: systemClock }}>
    <App />
  </DepsProvider>,
);
