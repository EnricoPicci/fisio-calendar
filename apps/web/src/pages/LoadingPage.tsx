import { useDeps } from '../app/deps';

/** Shown while the session restores a previous sign-in (docs/architecture.md §7.2). */
export function LoadingPage() {
  const { strings } = useDeps();
  return (
    <main className="mx-auto max-w-lg p-6" aria-busy="true">
      <p role="status" className="text-stone-500">
        {strings.common.loading}
      </p>
    </main>
  );
}
