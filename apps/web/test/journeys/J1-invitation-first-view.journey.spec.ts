import { stringsIt } from '@fisio/contracts';
import { closeTestDocumentClient } from '@fisio/testkit';
import { afterAll, describe, expect } from 'vitest';
import { HomeViewModel } from '../../src/viewmodels/HomeViewModel';
import { SignInViewModel } from '../../src/viewmodels/SignInViewModel';
import { journey } from './harness';

afterAll(closeTestDocumentClient);

describe('H. Headless UI journeys (architecture §10.5)', () => {
  journey('J1 — invitation, one-time code, first view of the calendar', async (j) => {
    await j.invite('Anna Verdi', 'anna@example.it');
    const invitation = j.emails.to('anna@example.it');
    expect(invitation.map((m) => m.notificationKey)).toEqual([expect.stringMatching(/^INVITE#/)]);

    const anna = j.client('anna@example.it');
    const page = j.record(anna.session.page$);
    const signIn = anna.open(SignInViewModel);
    const [step, busy, error] = j.record(signIn.step$, signIn.busy$, signIn.error$);

    await signIn.requestCode('anna@example.it');
    expect(step.latest).toBe('code');
    await signIn.confirmCode(j.emails.codeFor('anna@example.it', j));

    expect(busy.values).toEqual([false, true, false, true, false]);
    // Each attempt clears the error first.
    expect(error.values).toEqual([null, null, null]);
    await page.next((p) => p === 'client');
    signIn.dispose();

    // The client's home: the greeting from GET /me and the calendar's place (the week view
    // arrives with WP1.3).
    const home = anna.open(HomeViewModel);
    const [welcome, homeError] = j.record(home.welcome$, home.error$);
    expect(await welcome.next()).toBe(`${stringsIt.home.greeting}, Anna Verdi`);
    expect(homeError.values).toEqual([null]);

    expect(j.trace.apiCalls()).toEqual(['POST /api/v1/admin/clients', 'GET /api/v1/me']);
    expect(j.trace.apiCalls('auth').filter((call) => call.includes('email-otp'))).toEqual([
      'POST /email-otp',
      'POST /email-otp/answer',
    ]);
    expect(j.emails.to('anna@example.it').map((m) => m.notificationKey.split('#')[0])).toEqual([
      'INVITE',
      'AUTH_OTP',
    ]);
    await anna.dispose();
    expect(page.completed && welcome.completed).toBe(true);
  });
});
