import type { ReactElement } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { ClientHomePage } from '../pages/ClientHomePage';
import { LoadingPage } from '../pages/LoadingPage';
import { SetupPage } from '../pages/SetupPage';
import { SignInPage } from '../pages/SignInPage';
import { TherapistHomePage } from '../pages/TherapistHomePage';
import type { SessionPage } from '../viewmodels/SessionViewModel';
import { useDeps } from './deps';
import { useObservable } from './use-observable';

/**
 * The shell (docs/architecture.md §7.2): the setup link has its own route; every other path
 * shows the page the session names (`page$`): loading, sign-in, or the signed-in role's home.
 * Role-specific routes arrive with the pages of M1.
 */
const PAGES: Record<SessionPage, () => ReactElement> = {
  loading: LoadingPage,
  signIn: SignInPage,
  client: ClientHomePage,
  therapist: TherapistHomePage,
};

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<SessionPageView />} />
      </Routes>
    </BrowserRouter>
  );
}

function SessionPageView() {
  const { session } = useDeps();
  const page = useObservable(session.page$, 'loading');
  const Page = PAGES[page];
  return <Page />;
}
