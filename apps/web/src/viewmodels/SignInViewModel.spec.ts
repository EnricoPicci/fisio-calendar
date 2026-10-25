import { stringsIt as strings } from '@fisio/contracts';
import { of, throwError } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeAuthService, fakeAuth } from '../../test/support/fake-auth';
import { fakeTokens } from '../../test/support/jwt';
import { AuthError } from '../services/auth-service';
import type { SessionSink } from './SessionViewModel';
import { SignInViewModel } from './SignInViewModel';

const tokens = fakeTokens('client', 1_800_000_000);
const EMAIL = 'anna@example.it';

describe('C1 Client sign-in with a one-time code (architecture §3.3, §10.4)', () => {
  let scheduler: TestScheduler;
  let auth: FakeAuthService;
  let session: SessionSink;
  let vm: SignInViewModel;

  beforeEach(() => {
    scheduler = new TestScheduler((actual, expected) => expect(actual).toEqual(expected));
    auth = fakeAuth();
    session = { start: vi.fn() };
    vm = new SignInViewModel(auth, session, strings);
  });

  /** Moves to the code step synchronously, as after a completed requestCode(). */
  const atCodeStep = () => {
    auth.requestCode.mockReturnValue(of(undefined));
    void vm.requestCode(EMAIL);
  };

  it('requestCode(): busy$ while the request is in flight, then step$ moves to code', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.requestCode.mockReturnValue(cold('--a|', { a: undefined }));
      void vm.requestCode(EMAIL);
      expectObservable(vm.busy$).toBe('t-f', { t: true, f: false });
      expectObservable(vm.step$).toBe('e-c', { e: 'email', c: 'code' });
      expectObservable(vm.error$).toBe('n', { n: null });
    });
    expect(auth.requestCode).toHaveBeenCalledWith(EMAIL);
  });

  it('wrong code: error$ carries the code_mismatch message and step$ stays on code', () => {
    scheduler.run(({ cold, expectObservable }) => {
      atCodeStep();
      auth.confirmCode.mockReturnValue(cold('--#', undefined, new AuthError('code_mismatch')));
      void vm.confirmCode('00000000');
      expectObservable(vm.busy$).toBe('t-f', { t: true, f: false });
      expectObservable(vm.error$).toBe('n-e', { n: null, e: strings.auth.errors.code_mismatch });
      expectObservable(vm.step$).toBe('c', { c: 'code' });
    });
    expect(session.start).not.toHaveBeenCalled();
  });

  it('expired code: error$ explains and step$ returns to email for a new code', () => {
    scheduler.run(({ cold, expectObservable }) => {
      atCodeStep();
      auth.confirmCode.mockReturnValue(cold('--#', undefined, new AuthError('code_expired')));
      void vm.confirmCode('12345678');
      expectObservable(vm.error$).toBe('n-e', { n: null, e: strings.auth.errors.code_expired });
      expectObservable(vm.step$).toBe('c-e', { c: 'code', e: 'email' });
    });
  });

  it('lockout: error$ carries the too_many_attempts message and step$ returns to email', () => {
    scheduler.run(({ cold, expectObservable }) => {
      atCodeStep();
      auth.confirmCode.mockReturnValue(cold('--#', undefined, new AuthError('too_many_attempts')));
      void vm.confirmCode('12345678');
      expectObservable(vm.busy$).toBe('t-f', { t: true, f: false });
      expectObservable(vm.error$).toBe('n-e', {
        n: null,
        e: strings.auth.errors.too_many_attempts,
      });
      expectObservable(vm.step$).toBe('c-e', { c: 'code', e: 'email' });
    });
  });

  it('success: the tokens start the session, error$ stays null', () => {
    scheduler.run(({ cold, expectObservable }) => {
      atCodeStep();
      auth.confirmCode.mockReturnValue(cold('--t|', { t: tokens }));
      void vm.confirmCode('12345678');
      expectObservable(vm.busy$).toBe('t-f', { t: true, f: false });
      expectObservable(vm.error$).toBe('n', { n: null });
    });
    expect(session.start).toHaveBeenCalledWith(tokens);
  });

  it('a network failure reads as offline and the step does not move', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.requestCode.mockReturnValue(cold('-#', undefined, new TypeError('Failed to fetch')));
      void vm.requestCode(EMAIL);
      expectObservable(vm.error$).toBe('ne', { n: null, e: strings.common.offline });
      expectObservable(vm.step$).toBe('e', { e: 'email' });
    });
  });

  it('a second submit while busy$ is ignored (no double request)', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.requestCode.mockReturnValue(cold('---a|', { a: undefined }));
      void vm.requestCode(EMAIL);
      void vm.requestCode(EMAIL);
      expectObservable(vm.busy$).toBe('t--f', { t: true, f: false });
    });
    expect(auth.requestCode).toHaveBeenCalledTimes(1);
  });

  it('a new attempt clears the previous error$', () => {
    scheduler.run(({ cold, expectObservable }) => {
      atCodeStep();
      auth.confirmCode
        .mockReturnValueOnce(cold('-#', undefined, new AuthError('code_mismatch')))
        .mockReturnValueOnce(cold('--t|', { t: tokens }));
      void vm.confirmCode('1');
      scheduler.schedule(() => void vm.confirmCode('2'), 2);
      expectObservable(vm.error$).toBe('nen', {
        n: null,
        e: strings.auth.errors.code_mismatch,
      });
    });
  });

  it('the promise settles after the effect, success or failure, and never rejects', async () => {
    auth.requestCode.mockReturnValueOnce(of(undefined));
    await expect(vm.requestCode(EMAIL)).resolves.toBeUndefined();
    auth.confirmCode.mockReturnValueOnce(throwError(() => new Error('x')));
    await expect(vm.confirmCode('1')).resolves.toBeUndefined();
  });
});

describe('T1 Therapist sign-in with password and TOTP (architecture §3.3, §8.1, §10.4)', () => {
  let scheduler: TestScheduler;
  let auth: FakeAuthService;
  let session: SessionSink;
  let vm: SignInViewModel;
  const therapistTokens = fakeTokens('therapist', 1_800_000_000);

  beforeEach(() => {
    scheduler = new TestScheduler((actual, expected) => expect(actual).toEqual(expected));
    auth = fakeAuth();
    session = { start: vi.fn() };
    vm = new SignInViewModel(auth, session, strings);
    vm.showTherapistSignIn();
  });

  /** Moves to the TOTP step synchronously, as after an accepted password. */
  const atTotpStep = () => {
    auth.signInWithPassword.mockReturnValue(of({ kind: 'totp_required' as const }));
    void vm.signInWithPassword('t@example.it', 'password-of-twelve');
  };

  it('showTherapistSignIn() shows the password form; showClientSignIn() goes back and clears error$', () => {
    scheduler.run(({ cold, expectObservable }) => {
      expectObservable(vm.step$).toBe('p--e', { p: 'password', e: 'email' });
      auth.signInWithPassword.mockReturnValue(
        cold('-#', undefined, new AuthError('not_authorized')),
      );
      void vm.signInWithPassword('t@example.it', 'wrong');
      scheduler.schedule(() => vm.showClientSignIn(), 3);
      expectObservable(vm.error$).toBe('ne-n', {
        n: null,
        e: strings.auth.errors.not_authorized,
      });
    });
  });

  it('the password is accepted: step$ moves to totp, the SOFTWARE_TOKEN_MFA challenge', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.signInWithPassword.mockReturnValue(
        cold('--s|', { s: { kind: 'totp_required' as const } }),
      );
      void vm.signInWithPassword('t@example.it', 'password-of-twelve');
      expectObservable(vm.busy$).toBe('t-f', { t: true, f: false });
      expectObservable(vm.step$).toBe('p-t', { p: 'password', t: 'totp' });
    });
    expect(auth.signInWithPassword).toHaveBeenCalledWith('t@example.it', 'password-of-twelve');
  });

  it('wrong TOTP code is refused: error$ code_mismatch, step$ stays on totp', () => {
    scheduler.run(({ cold, expectObservable }) => {
      atTotpStep();
      auth.confirmTotp.mockReturnValue(cold('--#', undefined, new AuthError('code_mismatch')));
      void vm.confirmTotp('000000');
      expectObservable(vm.error$).toBe('n-e', { n: null, e: strings.auth.errors.code_mismatch });
      expectObservable(vm.step$).toBe('t', { t: 'totp' });
    });
    expect(session.start).not.toHaveBeenCalled();
  });

  it('a stale TOTP challenge sends the therapist back to the password step', () => {
    scheduler.run(({ cold, expectObservable }) => {
      atTotpStep();
      auth.confirmTotp.mockReturnValue(cold('--#', undefined, new AuthError('invalid_session')));
      void vm.confirmTotp('123456');
      expectObservable(vm.step$).toBe('t-p', { t: 'totp', p: 'password' });
    });
  });

  it('the TOTP code is accepted: the tokens start the session', () => {
    scheduler.run(({ cold, expectObservable }) => {
      atTotpStep();
      auth.confirmTotp.mockReturnValue(cold('--t|', { t: therapistTokens }));
      void vm.confirmTotp('123456');
      expectObservable(vm.busy$).toBe('t-f', { t: true, f: false });
    });
    expect(session.start).toHaveBeenCalledWith(therapistTokens);
  });

  it('a password sign-in without an MFA step signs in at once (TOTP not yet enrolled)', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.signInWithPassword.mockReturnValue(
        cold('-s|', { s: { kind: 'signed_in' as const, tokens: therapistTokens } }),
      );
      void vm.signInWithPassword('t@example.it', 'password-of-twelve');
      expectObservable(vm.step$).toBe('p', { p: 'password' });
    });
    expect(session.start).toHaveBeenCalledWith(therapistTokens);
  });
});
