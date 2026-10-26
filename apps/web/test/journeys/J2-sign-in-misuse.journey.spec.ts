import { stringsIt } from '@fisio/contracts';
import { closeTestDocumentClient } from '@fisio/testkit';
import { afterAll, describe, expect } from 'vitest';
import { SignInViewModel } from '../../src/viewmodels/SignInViewModel';
import { journey } from './harness';

afterAll(closeTestDocumentClient);

const EMAIL = 'bruno@example.it';
const { errors } = stringsIt.auth;

describe('H. Headless UI journeys (architecture §10.5)', () => {
  journey('J2 — sign-in misuse: wrong code, expired code, lockout', async (j) => {
    await j.seedClient('Bruno Neri', EMAIL);
    const bruno = j.client(EMAIL);
    const page = j.record(bruno.session.page$);
    const signIn = bruno.open(SignInViewModel);
    const [step, , error] = j.record(signIn.step$, signIn.busy$, signIn.error$);
    /** A code that is certainly not the one sent: the last digit of the real one, changed. */
    const wrongCode = () => {
      const code = j.emails.codeFor(EMAIL, j);
      return j.redact(`${code.slice(0, -1)}${(Number(code.at(-1)) + 1) % 10}`, 'wrong code');
    };

    // A wrong code keeps the code step, with the reason.
    await signIn.requestCode(EMAIL);
    await signIn.confirmCode(wrongCode());
    expect(error.latest).toBe(errors.code_mismatch);
    expect(step.latest).toBe('code');

    // The right code, but too late: back to the email step.
    j.advance({ minutes: 6 });
    await signIn.confirmCode(j.emails.codeFor(EMAIL, j));
    expect(error.latest).toBe(errors.code_expired);
    expect(step.latest).toBe('email');

    // Out of the lockout window of the first wrong code, five wrong codes in a row lock the
    // address: the fifth answer is the lockout, and the flow starts over.
    j.advance({ minutes: 15 });
    await signIn.requestCode(EMAIL);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await signIn.confirmCode(wrongCode());
      expect(error.latest).toBe(errors.code_mismatch);
    }
    await signIn.confirmCode(wrongCode());
    expect(error.latest).toBe(errors.too_many_attempts);
    expect(step.latest).toBe('email');

    // While locked, even a fresh request leads nowhere: no code is sent, and the step refuses.
    const codes = j.emails.to(EMAIL).length;
    await signIn.requestCode(EMAIL);
    await signIn.confirmCode('12345678');
    expect(j.emails.to(EMAIL)).toHaveLength(codes);
    expect(error.latest).toBe(errors.too_many_attempts);

    expect(page.values).toEqual(['signIn']);
    expect(j.trace.apiCalls()).toEqual([]);
    await bruno.dispose();
    expect(j.trace.openSubscriptions()).toEqual(new Map());
  });
});
