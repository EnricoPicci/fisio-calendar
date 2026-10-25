import { ClientIdSchema, type MeResponse, stringsIt as strings } from '@fisio/contracts';
import { TestScheduler } from 'rxjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { type FakeApiClient, fakeApi } from '../../test/support/fake-api';
import { ApiError } from '../services/api-client';
import { HomeViewModel } from './HomeViewModel';

const client: MeResponse = {
  role: 'client',
  clientId: ClientIdSchema.parse('6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c'),
  name: 'Giulia Bianchi',
  email: 'giulia.bianchi@fisio.test',
  locale: 'it',
};
const therapist: MeResponse = {
  role: 'therapist',
  therapistId: '0f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c',
};

describe('Home page: who is signed in, from GET /me (architecture §7.2, WP0.7 placeholders)', () => {
  let scheduler: TestScheduler;
  let api: FakeApiClient;

  beforeEach(() => {
    scheduler = new TestScheduler((actual, expected) => expect(actual).toEqual(expected));
    api = fakeApi();
  });

  it('welcome$ greets a client by name', () => {
    scheduler.run(({ cold, expectObservable }) => {
      api.me.mockReturnValue(cold('--m|', { m: client }));
      const vm = new HomeViewModel(api, strings);
      expectObservable(vm.welcome$).toBe('--w|', { w: 'Ciao, Giulia Bianchi' });
      expectObservable(vm.error$).toBe('n', { n: null });
    });
  });

  it('welcome$ greets the therapist', () => {
    scheduler.run(({ cold, expectObservable }) => {
      api.me.mockReturnValue(cold('-m|', { m: therapist }));
      const vm = new HomeViewModel(api, strings);
      expectObservable(vm.welcome$).toBe('-w|', { w: strings.home.greetingTherapist });
    });
  });

  it('the request runs once for every subscriber of welcome$', () => {
    scheduler.run(({ cold, expectObservable }) => {
      api.me.mockReturnValue(cold('--m|', { m: client }));
      const vm = new HomeViewModel(api, strings);
      expectObservable(vm.welcome$).toBe('--w|', { w: 'Ciao, Giulia Bianchi' });
      expectObservable(vm.welcome$, '-^').toBe('--w|', { w: 'Ciao, Giulia Bianchi' });
    });
    expect(api.me).toHaveBeenCalledTimes(1);
  });

  it('a refused request: error$ carries the Italian message and welcome$ falls back to the plain greeting', () => {
    scheduler.run(({ cold, expectObservable }) => {
      api.me.mockReturnValue(cold('--#', undefined, new ApiError('forbidden', 403)));
      const vm = new HomeViewModel(api, strings);
      expectObservable(vm.welcome$).toBe('--(w|)', { w: strings.home.greeting });
      expectObservable(vm.error$).toBe('n-e', { n: null, e: strings.errors.forbidden });
    });
  });
});
