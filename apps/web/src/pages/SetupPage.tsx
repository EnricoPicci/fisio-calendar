import type { Strings } from '@fisio/contracts';
import type { ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ALERT, BUTTON, FIELD, FORM, INPUT, LINK } from '../app/classes';
import { useDeps, useViewModel } from '../app/deps';
import { onSubmit } from '../app/forms';
import { useObservable } from '../app/use-observable';
import { type SetupEnrolment, type SetupStep, SetupViewModel } from '../viewmodels/SetupViewModel';

/**
 * The therapist's setup page (docs/architecture.md §11.5), opened by the bootstrap link
 * `/setup#email=…&code=…`: binding only. The fragment goes to the view-model as it is. The
 * error sits above the form, where a phone keeps it visible with the keyboard open.
 */
export function SetupPage() {
  const { strings } = useDeps();
  const { hash } = useLocation();
  const vm = useViewModel((deps) => new SetupViewModel(deps.auth, deps.session, deps.strings));
  const step = useObservable(vm.step$, 'password');
  const busy = useObservable(vm.busy$, false);
  const error = useObservable(vm.error$, null);
  const enrolment = useObservable(vm.enrolment$, null);
  const Step = STEPS[step];
  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-2xl font-semibold">{strings.setup.title}</h1>
      {error ? (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      ) : null}
      <Step vm={vm} busy={busy} strings={strings} link={hash} enrolment={enrolment} />
    </main>
  );
}

interface StepProps {
  readonly vm: SetupViewModel;
  readonly busy: boolean;
  readonly strings: Strings;
  readonly link: string;
  readonly enrolment: SetupEnrolment | null;
}

const STEPS: Record<SetupStep, (props: StepProps) => ReactElement> = {
  password: PasswordStep,
  totp: TotpStep,
  done: Done,
};

function PasswordStep({ vm, busy, strings, link }: StepProps) {
  return (
    <form
      className={FORM}
      aria-busy={busy}
      onSubmit={onSubmit((f) => vm.startSetup(link, f.raw('password')))}
    >
      <p>{strings.setup.intro}</p>
      <label className={FIELD}>
        <span>{strings.setup.passwordLabel}</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          className={INPUT}
        />
      </label>
      <button type="submit" disabled={busy} className={BUTTON}>
        {strings.setup.continue}
      </button>
    </form>
  );
}

function TotpStep({ vm, busy, strings, enrolment }: StepProps) {
  return (
    <form
      className={FORM}
      aria-busy={busy}
      onSubmit={onSubmit((f) => vm.verifyTotp(f.get('code')))}
    >
      <p>{strings.setup.totpIntro}</p>
      <p className={FIELD}>
        <span>{strings.setup.secretLabel}</span>
        <code className="break-all rounded-md bg-stone-100 p-3 text-base">{enrolment?.secret}</code>
      </p>
      {enrolment?.otpauthUri ? (
        <a href={enrolment.otpauthUri} className={LINK}>
          {strings.setup.openAuthenticator}
        </a>
      ) : null}
      <label className={FIELD}>
        <span>{strings.setup.totpLabel}</span>
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          className={INPUT}
        />
      </label>
      <button type="submit" disabled={busy} className={BUTTON}>
        {strings.setup.finish}
      </button>
    </form>
  );
}

function Done() {
  return <Navigate to="/" replace />;
}
