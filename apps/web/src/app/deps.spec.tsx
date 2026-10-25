// @vitest-environment jsdom
import { stringsIt as strings } from '@fisio/contracts';
import { FixedClock } from '@fisio/domain';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeApi } from '../../test/support/fake-api';
import { fakeAuth } from '../../test/support/fake-auth';
import { SessionViewModel } from '../viewmodels/SessionViewModel';
import { SignInViewModel } from '../viewmodels/SignInViewModel';
import { type AppDeps, DepsProvider, useDeps, useViewModel } from './deps';

const created: SignInViewModel[] = [];

function ViewModelProbe() {
  const vm = useViewModel((d) => new SignInViewModel(d.auth, d.session, d.strings));
  created.push(vm);
  return null;
}

function DepsProbe() {
  useDeps();
  return null;
}

function deps(): AppDeps {
  const auth = fakeAuth();
  const clock = new FixedClock('2027-03-01T08:00:00.000Z');
  return { api: fakeApi(), auth, session: new SessionViewModel(auth, clock), strings, clock };
}

beforeEach(() => {
  created.length = 0;
});
afterEach(() => cleanup());

describe('Dependency context for templates (architecture §7.1)', () => {
  it('useViewModel() builds one view-model per mounted page and disposes it on unmount', () => {
    const { rerender, unmount } = render(
      <DepsProvider deps={deps()}>
        <ViewModelProbe />
      </DepsProvider>,
    );
    rerender(
      <DepsProvider deps={deps()}>
        <ViewModelProbe />
      </DepsProvider>,
    );
    expect(new Set(created).size).toBe(1);
    expect(created[0]?.isDisposed()).toBe(false);
    unmount();
    expect(created[0]?.isDisposed()).toBe(true);
  });

  it('useDeps() outside a DepsProvider is a programming error, not an empty object', () => {
    const silenced = console.error;
    console.error = () => undefined;
    try {
      expect(() => render(<DepsProbe />)).toThrow(/DepsProvider/);
    } finally {
      console.error = silenced;
    }
  });
});
