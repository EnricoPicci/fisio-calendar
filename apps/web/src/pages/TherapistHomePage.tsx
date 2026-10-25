import { useDeps, useViewModel } from '../app/deps';
import { useObservable } from '../app/use-observable';
import { HomeViewModel } from '../viewmodels/HomeViewModel';

/**
 * The therapist's home (docs/architecture.md §7.2): a greeting and the place of the dashboard,
 * until WP1.7. Binding only.
 */
export function TherapistHomePage() {
  const { strings, session } = useDeps();
  const vm = useViewModel((deps) => new HomeViewModel(deps.api, deps.strings));
  const welcome = useObservable(vm.welcome$, strings.common.loading);
  const error = useObservable(vm.error$, null);
  return (
    <main className="mx-auto max-w-lg p-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{welcome}</h1>
        <button type="button" className="text-teal-800 underline" onClick={() => session.signOut()}>
          {strings.common.signOut}
        </button>
      </header>
      {error ? (
        <p role="alert" className="mt-4 text-red-700">
          {error}
        </p>
      ) : null}
      <section className="mt-8">
        <h2 className="text-lg font-medium">{strings.home.therapist.title}</h2>
        <p className="mt-2 text-stone-600">{strings.home.therapist.soon}</p>
      </section>
    </main>
  );
}
