import { useDeps, useViewModel } from '../app/deps';
import { useObservable } from '../app/use-observable';
import { HomeViewModel } from '../viewmodels/HomeViewModel';

/**
 * The client's home (docs/architecture.md §7.2): greeting, the empty bookings list and the
 * calendar's place, until "My bookings" and the calendar arrive (WP1.3). Binding only.
 */
export function ClientHomePage() {
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
        <h2 className="text-lg font-medium">{strings.home.client.bookingsTitle}</h2>
        <p className="mt-2 text-stone-600">{strings.home.client.noBookings}</p>
      </section>
      <section className="mt-8 rounded-lg border border-dashed border-stone-300 p-6 text-center text-stone-500">
        {strings.home.client.calendarSoon}
      </section>
    </main>
  );
}
