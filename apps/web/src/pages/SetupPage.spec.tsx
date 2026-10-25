// @vitest-environment jsdom
import { stringsIt as strings } from '@fisio/contracts';
import { FixedClock } from '@fisio/domain';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../../test/support/fake-api';
import { type FakeAuthService, fakeAuth } from '../../test/support/fake-auth';
import { fakeTokens } from '../../test/support/jwt';
import { DepsProvider } from '../app/deps';
import { SessionViewModel } from '../viewmodels/SessionViewModel';
import { SetupPage } from './SetupPage';

/** Template binding tests (architecture §10.1) for the therapist's setup link. */
const LINK = '/setup#email=terapista%40fisio.test&code=one-time-code';
const TOTP_KEY = 'AAAABBBBCCCCDDDD';
const enrolment = {
  secret: TOTP_KEY,
  otpauthUri: `otpauth://totp/x?secret=${TOTP_KEY}`,
};

function renderSetup(auth: FakeAuthService, link = LINK) {
  const session = new SessionViewModel(auth, new FixedClock('2027-03-01T08:00:00.000Z'));
  const start = vi.spyOn(session, 'start');
  render(
    <MemoryRouter initialEntries={[link]}>
      <DepsProvider
        deps={{
          api: fakeApi(),
          auth,
          session,
          strings,
          clock: new FixedClock('2027-03-01T08:00:00Z'),
        }}
      >
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/" element={<p>home</p>} />
        </Routes>
      </DepsProvider>
    </MemoryRouter>,
  );
  return { start };
}

function submit(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  const form = input.closest('form');
  if (!form) throw new Error('the input is not inside a form');
  fireEvent.submit(form);
}

afterEach(() => cleanup());

describe('Setup page binding (architecture §11.5, §7.1 templates)', () => {
  it('the password form hands the link fragment and the password, untrimmed, to startSetup()', () => {
    const auth = fakeAuth();
    auth.startSetup.mockReturnValue(of(enrolment));
    renderSetup(auth);

    submit(screen.getByLabelText(strings.setup.passwordLabel), ' password-of-twelve ');

    expect(auth.startSetup).toHaveBeenCalledWith({
      email: 'terapista@fisio.test',
      code: 'one-time-code',
      password: ' password-of-twelve ',
    });
  });

  it('shows enrolment$ (secret and authenticator link); the first code calls verifyTotp(); done goes home', async () => {
    const auth = fakeAuth();
    const tokens = fakeTokens('therapist', 1_800_000_000);
    auth.startSetup.mockReturnValue(of(enrolment));
    auth.verifyTotpSetup.mockReturnValue(of(tokens));
    const { start } = renderSetup(auth);
    submit(screen.getByLabelText(strings.setup.passwordLabel), 'password-of-twelve');

    expect((await screen.findByText(enrolment.secret)).tagName).toBe('CODE');
    expect(
      screen.getByRole('link', { name: strings.setup.openAuthenticator }).getAttribute('href'),
    ).toBe(enrolment.otpauthUri);

    submit(screen.getByLabelText(strings.setup.totpLabel), '123456');

    expect(auth.verifyTotpSetup).toHaveBeenCalledWith('123456');
    expect(start).toHaveBeenCalledWith(tokens);
    expect(await screen.findByText('home')).toBeTruthy();
  });

  it('shows error$ as an alert (a link without a code is refused before any request)', async () => {
    const auth = fakeAuth();
    renderSetup(auth, '/setup#email=only');

    submit(screen.getByLabelText(strings.setup.passwordLabel), 'password-of-twelve');

    expect((await screen.findByRole('alert')).textContent).toBe(strings.setup.invalidLink);
    expect(auth.startSetup).not.toHaveBeenCalled();
  });
});
