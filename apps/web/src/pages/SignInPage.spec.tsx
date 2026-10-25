// @vitest-environment jsdom
import { stringsIt as strings } from '@fisio/contracts';
import { FixedClock } from '@fisio/domain';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NEVER, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../../test/support/fake-api';
import { type FakeAuthService, fakeAuth } from '../../test/support/fake-auth';
import { fakeTokens } from '../../test/support/jwt';
import { DepsProvider } from '../app/deps';
import { AuthError } from '../services/auth-service';
import { SessionViewModel } from '../viewmodels/SessionViewModel';
import { SignInPage } from './SignInPage';

/**
 * Template binding tests (architecture §10.1): the page shows what the view-model emits and
 * calls what it should. Behaviour itself is proven by the view-model specs and the journeys.
 */
function renderPage(auth: FakeAuthService) {
  const session = new SessionViewModel(auth, new FixedClock('2027-03-01T08:00:00.000Z'));
  const start = vi.spyOn(session, 'start');
  render(
    <DepsProvider
      deps={{
        api: fakeApi(),
        auth,
        session,
        strings,
        clock: new FixedClock('2027-03-01T08:00:00Z'),
      }}
    >
      <SignInPage />
    </DepsProvider>,
  );
  return { session, start };
}

function submit(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  const form = input.closest('form');
  if (!form) throw new Error('the input is not inside a form');
  fireEvent.submit(form);
}

afterEach(() => cleanup());

describe('Sign-in page binding (architecture §7.1 templates, §10.1)', () => {
  it('shows the email form; a submitted email calls requestCode(email) and the code form follows step$', async () => {
    const auth = fakeAuth();
    auth.requestCode.mockReturnValue(of(undefined));
    renderPage(auth);

    submit(screen.getByLabelText(strings.auth.emailLabel), 'anna@example.it');

    expect(auth.requestCode).toHaveBeenCalledWith('anna@example.it');
    expect(await screen.findByLabelText(strings.auth.codeLabel)).toBeTruthy();
    expect(screen.getByText(strings.auth.codeSent)).toBeTruthy();
  });

  it('a submitted code calls confirmCode(code); the tokens reach the session', async () => {
    const auth = fakeAuth();
    const tokens = fakeTokens('client', 1_800_000_000);
    auth.requestCode.mockReturnValue(of(undefined));
    auth.confirmCode.mockReturnValue(of(tokens));
    const { start } = renderPage(auth);
    submit(screen.getByLabelText(strings.auth.emailLabel), 'anna@example.it');

    submit(await screen.findByLabelText(strings.auth.codeLabel), '12345678');

    expect(auth.confirmCode).toHaveBeenCalledWith('12345678');
    expect(start).toHaveBeenCalledWith(tokens);
  });

  it('shows error$ as an alert when the code is refused', async () => {
    const auth = fakeAuth();
    auth.requestCode.mockReturnValue(of(undefined));
    auth.confirmCode.mockReturnValue(throwError(() => new AuthError('code_mismatch')));
    renderPage(auth);
    submit(screen.getByLabelText(strings.auth.emailLabel), 'anna@example.it');

    submit(await screen.findByLabelText(strings.auth.codeLabel), '00000000');

    expect((await screen.findByRole('alert')).textContent).toBe(strings.auth.errors.code_mismatch);
  });

  it('disables the submit button while busy$', async () => {
    const auth = fakeAuth();
    auth.requestCode.mockReturnValue(NEVER);
    renderPage(auth);
    const button = screen.getByRole('button', { name: strings.auth.requestCode });
    expect((button as HTMLButtonElement).disabled).toBe(false);

    submit(screen.getByLabelText(strings.auth.emailLabel), 'anna@example.it');

    expect(
      (await screen.findByRole('button', { name: strings.auth.requestCode })).hasAttribute(
        'disabled',
      ),
    ).toBe(true);
  });

  it('the therapist link shows the password form; its submit calls signInWithPassword(email, password)', async () => {
    const auth = fakeAuth();
    auth.signInWithPassword.mockReturnValue(of({ kind: 'totp_required' as const }));
    renderPage(auth);

    fireEvent.click(screen.getByRole('button', { name: strings.auth.therapistLink }));
    const password = await screen.findByLabelText(strings.auth.passwordLabel);
    fireEvent.change(screen.getByLabelText(strings.auth.emailLabel), {
      target: { value: 'terapista@fisio.test' },
    });
    submit(password, 'password-of-twelve');

    expect(auth.signInWithPassword).toHaveBeenCalledWith(
      'terapista@fisio.test',
      'password-of-twelve',
    );
    expect(await screen.findByLabelText(strings.auth.totpLabel)).toBeTruthy();
  });
});
