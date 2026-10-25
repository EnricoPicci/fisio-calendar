import { FixedClock } from '@fisio/domain';
import { NEVER, of } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { type FakeAuthService, fakeAuth } from '../../test/support/fake-auth';
import { fakeJwt, fakeTokens } from '../../test/support/jwt';
import { AuthError } from '../services/auth-service';
import { NetworkError } from '../services/network-error';
import { REFRESH_SKEW_SECONDS, SessionViewModel } from './SessionViewModel';

const NOW = new Date('2027-03-01T08:00:00.000Z');
const nowSeconds = Math.floor(NOW.getTime() / 1000);
const valid = fakeTokens('client', nowSeconds + 3600);
const expired = fakeTokens('client', nowSeconds - 1);
const expiringSoon = fakeTokens('client', nowSeconds + REFRESH_SKEW_SECONDS - 1);
const fresh = fakeTokens('client', nowSeconds + 3600);
const therapist = fakeTokens('therapist', nowSeconds + 3600);
const roleless = { accessToken: fakeJwt({ sub: 'x', exp: nowSeconds + 3600 }), idToken: 'x' };
const offline = () => new NetworkError(new TypeError('offline'));

describe('C1 Session: stay signed in on the device (architecture §8.1, §10.4)', () => {
  let scheduler: TestScheduler;
  let auth: FakeAuthService;
  let vm: SessionViewModel;

  beforeEach(() => {
    scheduler = new TestScheduler((actual, expected) => expect(actual).toEqual(expected));
    auth = fakeAuth();
    auth.signOut.mockReturnValue(of(undefined));
    vm = new SessionViewModel(auth, new FixedClock(NOW));
  });

  it('token expires mid-session → silent refresh keeps the user signed in', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.refresh.mockReturnValue(cold('--r|', { r: fresh }));
      vm.start(expired);
      expectObservable(vm.accessToken$).toBe('--r|', { r: fresh.accessToken });
      expectObservable(vm.page$).toBe('c', { c: 'client' });
    });
    expect(auth.refresh).toHaveBeenCalledTimes(1);
  });

  it('a token about to expire (within the skew) is refreshed before use', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.refresh.mockReturnValue(cold('-r|', { r: fresh }));
      vm.start(expiringSoon);
      expectObservable(vm.accessToken$).toBe('-r|', { r: fresh.accessToken });
    });
  });

  it('a token still valid is used as it is, without a token request', () => {
    scheduler.run(({ expectObservable }) => {
      vm.start(valid);
      expectObservable(vm.accessToken$).toBe('(a|)', { a: valid.accessToken });
    });
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('a token without a usable expiry is refreshed, so the next one has a known lifetime', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.refresh.mockReturnValue(cold('-r|', { r: fresh }));
      vm.start({ accessToken: fakeJwt({ role: 'client' }), idToken: fakeJwt({ role: 'client' }) });
      expectObservable(vm.accessToken$).toBe('-r|', { r: fresh.accessToken });
    });
  });

  it('requests made during a refresh share the one token request', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.refresh.mockReturnValue(cold('--r|', { r: fresh }));
      vm.start(expired);
      expectObservable(vm.accessToken$).toBe('--r|', { r: fresh.accessToken });
      expectObservable(vm.accessToken$, '-^').toBe('--r|', { r: fresh.accessToken });
    });
    expect(auth.refresh).toHaveBeenCalledTimes(1);
  });

  it('a request cancelled during the refresh does not cancel it: the rotated tokens are kept', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.refresh.mockReturnValue(cold('---r|', { r: fresh }));
      vm.start(expired);
      expectObservable(vm.accessToken$, '^-!').toBe('--');
      expectObservable(vm.accessToken$, '----^').toBe('----(a|)', { a: fresh.accessToken });
    });
    expect(auth.refresh).toHaveBeenCalledTimes(1);
  });

  it('a refused refresh ends the session: accessToken$ yields null, signedOut$ explains, page$ is signIn', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.refresh.mockReturnValue(cold('--#', undefined, new AuthError('not_authorized')));
      vm.start(expired);
      expectObservable(vm.signedOut$).toBe('--s', { s: 'refresh_refused' });
      expectObservable(vm.accessToken$).toBe('--(n|)', { n: null });
      expectObservable(vm.page$).toBe('c-s', { c: 'client', s: 'signIn' });
    });
  });

  it('a refresh that yields tokens without a known role ends the session like a refused one, and the provider is signed out', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.refresh.mockReturnValue(cold('--r|', { r: roleless }));
      vm.start(expired);
      expectObservable(vm.accessToken$).toBe('--n|', { n: null });
      expectObservable(vm.page$).toBe('c-s', { c: 'client', s: 'signIn' });
      expectObservable(vm.signedOut$).toBe('--s', { s: 'refresh_refused' });
    });
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('a refresh refused for a passing reason (a lockout) fails this request only and keeps the session', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.refresh.mockReturnValue(cold('--#', undefined, new AuthError('too_many_attempts')));
      vm.start(expired);
      expectObservable(vm.accessToken$).toBe('--(n|)', { n: null });
      expectObservable(vm.signedOut$).toBe('----');
      expectObservable(vm.page$).toBe('c', { c: 'client' });
    });
  });

  it('a refresh that fails for a network error keeps the session and errors the request as offline', () => {
    scheduler.run(({ cold, expectObservable }) => {
      const failure = offline();
      auth.refresh.mockReturnValue(cold('--#', undefined, failure));
      vm.start(expired);
      expectObservable(vm.accessToken$).toBe('--#', undefined, failure);
      expectObservable(vm.signedOut$).toBe('----');
      expectObservable(vm.page$).toBe('c', { c: 'client' });
    });
  });

  it('signOut() during a silent refresh wins: the late refresh result does not sign the user back in', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.refresh.mockReturnValue(cold('----r|', { r: fresh }));
      auth.signOut.mockReturnValue(cold('-a|', { a: undefined }));
      vm.start(expired);
      expectObservable(vm.accessToken$).toBe('----n|', { n: null });
      scheduler.schedule(() => void vm.signOut(), 1);
      expectObservable(vm.page$).toBe('c--s', { c: 'client', s: 'signIn' });
      expectObservable(vm.signedOut$).toBe('---u', { u: 'user' });
    });
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('start() during a silent refresh wins: the late refresh does not replace the new session', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.refresh.mockReturnValue(cold('----r|', { r: fresh }));
      vm.start(expired);
      expectObservable(vm.accessToken$).toBe('----n|', { n: null });
      scheduler.schedule(() => vm.start(therapist), 1);
      expectObservable(vm.page$).toBe('ct', { c: 'client', t: 'therapist' });
      expectObservable(vm.signedOut$).toBe('------');
      expectObservable(vm.accessToken$, '-----^').toBe('-----(a|)', { a: therapist.accessToken });
    });
    expect(auth.refresh).toHaveBeenCalledTimes(1);
  });

  it('nobody signed in: accessToken$ yields null and no refresh is attempted', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.restore.mockReturnValue(cold('(n|)', { n: null }));
      void vm.restore();
      expectObservable(vm.accessToken$).toBe('(n|)', { n: null });
    });
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('accessToken$ subscribed before restore() has answered waits for it', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.restore.mockReturnValue(cold('--t|', { t: valid }));
      void vm.restore();
      expectObservable(vm.accessToken$).toBe('--(a|)', { a: valid.accessToken });
    });
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('page$ is loading until restore() has answered, then the signed-in role', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.restore.mockReturnValue(cold('-t|', { t: therapist }));
      void vm.restore();
      expectObservable(vm.page$).toBe('lt', { l: 'loading', t: 'therapist' });
    });
  });

  it('page$ is loading until restore() has answered, then signIn when nothing was kept', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.restore.mockReturnValue(cold('-n|', { n: null }));
      void vm.restore();
      expectObservable(vm.page$).toBe('ls', { l: 'loading', s: 'signIn' });
    });
  });

  it('a restore that fails, or completes without a value, leaves nobody signed in', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.restore.mockReturnValue(cold('-#', undefined, new Error('storage unavailable')));
      void vm.restore();
      expectObservable(vm.page$).toBe('ls', { l: 'loading', s: 'signIn' });
    });
    const second = new SessionViewModel(auth, new FixedClock(NOW));
    new TestScheduler((actual, expected) => expect(actual).toEqual(expected)).run(
      ({ cold, expectObservable }) => {
        auth.restore.mockReturnValue(cold('--|'));
        void second.restore();
        expectObservable(second.page$).toBe('l-s', { l: 'loading', s: 'signIn' });
      },
    );
  });

  it('start() refuses tokens whose access token names no known role and signs the provider out', () => {
    expect(() => vm.start(roleless)).toThrow(/role/);
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('restore() treats tokens without a known role as nobody and signs the provider out', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.restore.mockReturnValue(cold('-u|', { u: roleless }));
      void vm.restore();
      expectObservable(vm.page$).toBe('ls', { l: 'loading', s: 'signIn' });
      expectObservable(vm.accessToken$).toBe('-(n|)', { n: null });
    });
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('a restore() that answers after a sign-in completed does not replace that session', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.restore.mockReturnValue(cold('---n|', { n: null }));
      void vm.restore();
      scheduler.schedule(() => vm.start(therapist), 1);
      expectObservable(vm.page$).toBe('lt', { l: 'loading', t: 'therapist' });
    });
  });

  it('signOut() forgets the tokens, tells the provider and says why the session ended', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.signOut.mockReturnValue(cold('-a|', { a: undefined }));
      vm.start(valid);
      void vm.signOut();
      expectObservable(vm.signedOut$).toBe('--u', { u: 'user' });
      expectObservable(vm.page$).toBe('c-s', { c: 'client', s: 'signIn' });
    });
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('signOut() ends the session on the device even when the provider cannot be told', () => {
    scheduler.run(({ cold, expectObservable }) => {
      auth.signOut.mockReturnValue(cold('-#', undefined, offline()));
      vm.start(valid);
      void vm.signOut();
      expectObservable(vm.page$).toBe('cs', { c: 'client', s: 'signIn' });
    });
  });

  it('start() after a sign-in shows the role of the access token', () => {
    scheduler.run(({ expectObservable }) => {
      vm.start(therapist);
      expectObservable(vm.page$).toBe('t', { t: 'therapist' });
    });
  });

  it('dispose() completes the streams and settles a pending restore() or signOut()', async () => {
    auth.restore.mockReturnValue(NEVER);
    const pending = vm.restore();
    scheduler.run(({ expectObservable }) => {
      vm.dispose();
      expectObservable(vm.page$).toBe('|');
      expectObservable(vm.signedOut$).toBe('|');
    });
    await expect(
      Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 50)),
      ]),
    ).resolves.toBeUndefined();
  });
});
