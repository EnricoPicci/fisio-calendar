import { stringsIt } from '@fisio/contracts';
import { closeTestDocumentClient, renderTrace } from '@fisio/testkit';
import { firstValueFrom, lastValueFrom } from 'rxjs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { HomeViewModel } from '../../src/viewmodels/HomeViewModel';
import { FisioJourney } from '../journeys/harness';

afterAll(closeTestDocumentClient);

/** The parts of the web journey harness no journey uses yet (architecture §10.5). */
describe('Web journey harness (architecture §10.5)', () => {
  // Value: protects=the client actor's sign-in and time travel work before the journeys that need them (J3, J7, J11, J12) build on them; fails_when=ClientActor.signIn() stops reaching the client page, or advanceTo$ moves the clock without running the tick; why_new=no journey of WP0.8 calls them; seam=none; no_claim=what a tick delivers (the jobs specs)
  it('a seeded client signs in through the sign-in page; advanceTo$ moves the clock and runs the tick', async () => {
    const j = new FisioJourney();
    await j.seedClient('Carla Rossi', 'carla@example.it');
    const carla = await j.client('carla@example.it').signIn();
    expect(await firstValueFrom(carla.session.page$)).toBe('client');

    const tick = vi.spyOn(j, 'tick');
    await lastValueFrom(j.advanceTo$('2027-03-02T07:00:00.000Z'), { defaultValue: undefined });
    expect(j.clock.now().toISOString()).toBe('2027-03-02T07:00:00.000Z');
    // The delivery jobs ran (sweep, deliver-due) and the notifier settled before the step ended.
    expect(tick).toHaveBeenCalledOnce();
    expect(await tick.mock.results[0]?.value).toEqual({
      ran: ['sweep', 'deliver-due'],
      skipped: [],
    });
    const lines = renderTrace(j.trace.entries, { redactions: j.redactions });
    expect(lines.at(-1)).toMatch(/^\d+\. tick at 2027-03-02T07:00:00\.000Z$/);
    await j.finish();
    j.close();
  });

  // Value: protects=a second sign-in of the therapist in one journey (an invite() after another) neither sends a refused TOTP answer nor counts towards the lockout; fails_when=signIn() runs the flow again at the fixed clock and the reused code is refused, unnoticed because the page still says therapist; why_new=red-team finding of the WP0.8 ship review; seam=none; no_claim=sign-in after a sign-out
  it('a second therapist sign-in in the same journey sends nothing', async () => {
    const j = new FisioJourney();
    await j.therapist().signIn();
    const before = j.trace.apiCalls('auth').length;
    await j.therapist().signIn();
    expect(j.trace.apiCalls('auth')).toHaveLength(before);
    await j.finish();
    j.close();
  });

  // Value: protects=a journey that leaves a subscription open fails instead of rendering a green trace; fails_when=finish() or an actor's dispose() stops checking the open subscriptions, or counts them wrong; why_new=only the passing side ran (J1, J2, J8-a); seam=a view-model traced but never opened, so no page disposes it; no_claim=real view-models' dispose
  it('finish() fails while a view-model subscription stays open', async () => {
    const j = new FisioJourney();
    await j.seedClient('Carla Rossi', 'carla@example.it');
    const carla = await j.client('carla@example.it').signIn();
    const extra = j.traced(new HomeViewModel(carla.api, stringsIt), 'carla.extra');
    const orphan = j.traced(new HomeViewModel(carla.api, stringsIt), 'orphan.home');
    const subscriptions = [extra.error$.subscribe(), orphan.error$.subscribe()];
    // Every actor is disposed first; then one error names each stream still open.
    await expect(j.finish()).rejects.toThrow(
      'Subscriptions still open after dispose: carla.extra.error$, orphan.home.error$',
    );
    for (const subscription of subscriptions) subscription.unsubscribe();
    j.close();
  });
});
