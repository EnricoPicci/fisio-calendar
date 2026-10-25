import { stringsIt as strings } from '@fisio/contracts';
import { of } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeAuthService, fakeAuth } from '../../test/support/fake-auth';
import { fakeTokens } from '../../test/support/jwt';
import { AuthError } from '../services/auth-service';
import { NetworkError } from '../services/network-error';
import type { SessionSink } from './SessionViewModel';
import { SetupViewModel } from './SetupViewModel';

const LINK = '#email=terapista%40fisio.test&code=one-time-code';
const PASSWORD = 'password-of-twelve';
const provided = {
  secret: 'JBSWY3DPEHPK3PXP',
  otpauthUri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
};
const enrolment = { secret: provided.secret, otpauthUri: provided.otpauthUri };
const tokens = fakeTokens('therapist', 1_800_000_000);

describe('T1 Therapist setup link: password, then TOTP enrolment (architecture §11.5, §15)', () => {
  let scheduler: TestScheduler;
  let auth: FakeAuthService;
  let session: SessionSink;
  let vm: SetupViewModel;

  beforeEach(() => {
    scheduler = new TestScheduler((actual, expected) => expect(actual).toEqual(expected));
    auth = fakeAuth();
    session = { start: vi.fn() };
    vm = new SetupViewModel(auth, session, strings);
  });

  /** Moves to the TOTP step synchronously, as after an accepted password. */
  const atTotpStep = () => {
    auth.startSetup.mockReturnValue(of(provided));
    void vm.startSetup(LINK, PASSWORD);
  };

  it('a link without email or code is refused before any request', () => {
    scheduler.run(({ expectObservable }) => {
      void vm.startSetup('#code=only', PASSWORD);
      expectObservable(vm.error$).toBe('e', { e: strings.setup.invalidLink });
      expectObservable(vm.step$).toBe('p', { p: 'password' });
    });
    expect(auth.startSetup).not.toHaveBeenCalled();
  });

  it('startSetup(): the link and the password start the enrolment; enrolment$ shows the secret', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.startSetup.mockReturnValue(cold('--e|', { e: provided }));
      void vm.startSetup(LINK, PASSWORD);
      expectObservable(vm.busy$).toBe('t-f', { t: true, f: false });
      expectObservable(vm.step$).toBe('p-t', { p: 'password', t: 'totp' });
      expectObservable(vm.enrolment$).toBe('n-e', { n: null, e: enrolment });
    });
    expect(auth.startSetup).toHaveBeenCalledWith({
      email: 'terapista@fisio.test',
      code: 'one-time-code',
      password: PASSWORD,
    });
  });

  it('an authenticator link that is not an otpauth: URI is dropped, the secret stays', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.startSetup.mockReturnValue(
        cold('-e|', { e: { secret: provided.secret, otpauthUri: 'javascript:alert(1)' } }),
      );
      void vm.startSetup(LINK, PASSWORD);
      expectObservable(vm.enrolment$).toBe('ne', {
        n: null,
        e: { secret: provided.secret, otpauthUri: undefined },
      });
    });
  });

  it('a used or expired link reads as such (not as a wrong password); a short password as invalid_password', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.startSetup
        .mockReturnValueOnce(cold('-#', undefined, new AuthError('not_authorized')))
        .mockReturnValueOnce(cold('-#', undefined, new AuthError('invalid_password')));
      void vm.startSetup(LINK, PASSWORD);
      scheduler.schedule(() => void vm.startSetup(LINK, 'short'), 2);
      expectObservable(vm.error$).toBe('nenf', {
        n: null,
        e: strings.setup.linkUsed,
        f: strings.auth.errors.invalid_password,
      });
      expectObservable(vm.step$).toBe('p', { p: 'password' });
    });
  });

  it('verifyTotp(): the first authenticator code finishes the setup and starts the session', () => {
    scheduler.run(({ cold, expectObservable }) => {
      atTotpStep();
      auth.verifyTotpSetup.mockReturnValue(cold('--t|', { t: tokens }));
      void vm.verifyTotp('123456');
      expectObservable(vm.busy$).toBe('t-f', { t: true, f: false });
      expectObservable(vm.step$).toBe('t-d', { t: 'totp', d: 'done' });
    });
    expect(auth.verifyTotpSetup).toHaveBeenCalledWith('123456');
    expect(session.start).toHaveBeenCalledWith(tokens);
  });

  it('a wrong first code is refused and the enrolment stays open for another try', () => {
    scheduler.run(({ cold, expectObservable }) => {
      atTotpStep();
      auth.verifyTotpSetup.mockReturnValue(cold('-#', undefined, new AuthError('code_mismatch')));
      void vm.verifyTotp('000000');
      expectObservable(vm.error$).toBe('ne', { n: null, e: strings.auth.errors.code_mismatch });
      expectObservable(vm.step$).toBe('t', { t: 'totp' });
      expectObservable(vm.enrolment$).toBe('e', { e: enrolment });
    });
    expect(session.start).not.toHaveBeenCalled();
  });

  it('a lockout during the enrolment ends it (the lockout outlives the enrolment session): back to password, secret dropped', () => {
    scheduler.run(({ cold, expectObservable }) => {
      atTotpStep();
      auth.verifyTotpSetup.mockReturnValue(
        cold('-#', undefined, new AuthError('too_many_attempts')),
      );
      void vm.verifyTotp('000000');
      expectObservable(vm.error$).toBe('ne', { n: null, e: strings.auth.errors.too_many_attempts });
      expectObservable(vm.step$).toBe('tp', { t: 'totp', p: 'password' });
      expectObservable(vm.enrolment$).toBe('en', { e: enrolment, n: null });
    });
    expect(session.start).not.toHaveBeenCalled();
  });

  it.each(['invalid_session', 'not_authorized', 'code_expired', 'invalid_password'] as const)(
    'an enrolment the provider no longer accepts (%s) ends it: back to the password step, secret dropped',
    (code) => {
      scheduler.run(({ cold, expectObservable }) => {
        atTotpStep();
        auth.verifyTotpSetup.mockReturnValue(cold('-#', undefined, new AuthError(code)));
        void vm.verifyTotp('123456');
        expectObservable(vm.error$).toBe('ne', { n: null, e: strings.setup.enrolmentEnded });
        expectObservable(vm.step$).toBe('tp', { t: 'totp', p: 'password' });
        expectObservable(vm.enrolment$).toBe('en', { e: enrolment, n: null });
      });
      expect(session.start).not.toHaveBeenCalled();
    },
  );

  it('a network failure while verifying the first code keeps the enrolment open', () => {
    scheduler.run(({ cold, expectObservable }) => {
      atTotpStep();
      auth.verifyTotpSetup.mockReturnValue(
        cold('-#', undefined, new NetworkError(new TypeError('Failed to fetch'))),
      );
      void vm.verifyTotp('123456');
      expectObservable(vm.error$).toBe('ne', { n: null, e: strings.common.offline });
      expectObservable(vm.step$).toBe('t', { t: 'totp' });
      expectObservable(vm.enrolment$).toBe('e', { e: enrolment });
    });
  });
});
