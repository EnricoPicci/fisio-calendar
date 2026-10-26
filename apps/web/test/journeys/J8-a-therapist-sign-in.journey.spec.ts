import { stringsIt } from '@fisio/contracts';
import { closeTestDocumentClient } from '@fisio/testkit';
import { afterAll, describe, expect } from 'vitest';
import { HomeViewModel } from '../../src/viewmodels/HomeViewModel';
import { SignInViewModel } from '../../src/viewmodels/SignInViewModel';
import { journey, THERAPIST_EMAIL, THERAPIST_PASSWORD } from './harness';

afterAll(closeTestDocumentClient);

describe('H. Headless UI journeys (architecture §10.5)', () => {
  // J8 continues with the rules and the calendar (WP1.2); this is its sign-in part.
  journey('J8-a — therapist: password, authenticator code, home', async (j) => {
    await j.therapistAccount();
    const therapist = j.therapist();
    const page = j.record(therapist.session.page$);
    const signIn = therapist.open(SignInViewModel);
    const [step, busy, error] = j.record(signIn.step$, signIn.busy$, signIn.error$);

    signIn.showTherapistSignIn();
    expect(step.latest).toBe('password');
    await signIn.signInWithPassword(THERAPIST_EMAIL, THERAPIST_PASSWORD);
    // A password alone never signs the therapist in: the TOTP challenge always follows (T1).
    expect(step.latest).toBe('totp');
    expect(page.latest).toBe('signIn');

    // A wrong authenticator code keeps the TOTP step.
    await signIn.confirmTotp('000000' === (await j.totp()) ? '111111' : '000000');
    expect(error.latest).toBe(stringsIt.auth.errors.code_mismatch);
    expect(step.latest).toBe('totp');

    await signIn.confirmTotp(await j.totp());
    await page.next((p) => p === 'therapist');
    expect(busy.values).toEqual([false, true, false, true, false, true, false]);
    signIn.dispose();

    const home = therapist.open(HomeViewModel);
    const [welcome, homeError] = j.record(home.welcome$, home.error$);
    expect(await welcome.next()).toBe(stringsIt.home.greetingTherapist);
    expect(homeError.values).toEqual([null]);

    expect(j.trace.apiCalls()).toEqual(['GET /api/v1/me']);
    expect(j.trace.apiCalls('auth')).toEqual([
      'POST /password',
      'POST /totp/answer',
      'POST /totp/answer',
    ]);
    expect(j.emails.to(THERAPIST_EMAIL)).toEqual([]);
    await therapist.dispose();
  });
});
