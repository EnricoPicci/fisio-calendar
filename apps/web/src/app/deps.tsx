import type { Strings } from '@fisio/contracts';
import type { Clock } from '@fisio/domain';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import type { ApiClient } from '../services/api-client';
import type { AuthService } from '../services/auth-service';
import type { SessionViewModel } from '../viewmodels/SessionViewModel';
import type { ViewModel } from './view-model';

/**
 * Dependency injection for templates (docs/architecture.md §7.1): the composition root
 * (`main.tsx`) builds the services once and provides them; a page creates its view-model with
 * `useViewModel`, which disposes it when the page unmounts. Pages never import a service
 * implementation. (No `StrictMode`: its simulated unmount would dispose a view-model that is
 * still rendered.)
 */
export interface AppDeps {
  readonly api: ApiClient;
  readonly auth: AuthService;
  /** App-scoped: one session for the whole SPA. */
  readonly session: SessionViewModel;
  readonly strings: Strings;
  readonly clock: Clock;
}

const DepsContext = createContext<AppDeps | null>(null);

export function DepsProvider({ deps, children }: { deps: AppDeps; children: ReactNode }) {
  return <DepsContext value={deps}>{children}</DepsContext>;
}

export function useDeps(): AppDeps {
  const deps = useContext(DepsContext);
  if (!deps) throw new Error('useDeps() needs a DepsProvider above the page');
  return deps;
}

/** One view-model per mounted page, built from the dependencies and disposed on unmount. */
export function useViewModel<V extends ViewModel>(create: (deps: AppDeps) => V): V {
  const deps = useDeps();
  const [viewModel] = useState(() => create(deps));
  useEffect(() => () => viewModel.dispose(), [viewModel]);
  return viewModel;
}
