import type { Strings } from '@fisio/contracts';
import type { ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useDeps, useViewModel } from '../app/deps';
import { onSubmit } from '../app/forms';
import { useObservable } from '../app/use-observable';
import type { TotpEnrolment } from '../services/auth-service';
import { type SetupStep, SetupViewModel } from '../viewmodels/SetupViewModel';

/**
 * The therapist's setup page (docs/architecture.md §11.5), opened by the bootstrap link
 * `/setup#email=…&code=…`: binding only. The fragment goes to the view-model as it is.
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
      <Step vm={vm} busy={busy} strings={strings} link={hash} enrolment={enrolment} />
      {error ? (
        <p role="alert" className="mt-4 text-red-700">
          {error}
        </p>
      ) : null}
    </main>
  );
}

interface StepProps {
  readonly vm: SetupViewModel;
  readonly busy: boolean;
  readonly strings: Strings;
  readonly link: string;
  readonly enrolment: TotpEnrolment | null;
}

const STEPS: Record<SetupStep, (props: StepProps) => ReactElement> = {
  password: PasswordStep,
  totp: TotpStep,
  done: Done,
};

const FORM = 'mt-6 flex flex-col gap-4';
const FIELD = 'flex flex-col gap-1';
const INPUT = 'rounded-md border border-stone-300 px-3 py-3 text-lg';
const BUTTON =
  'rounded-md bg-teal-700 px-4 py-3 text-lg font-medium text-white disabled:opacity-50';

function PasswordStep({ vm, busy, strings, link }: StepProps) {
  return (
    <form className={FORM} onSubmit={onSubmit((f) => vm.startSetup(link, f.get('password')))}>
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
    <form className={FORM} onSubmit={onSubmit((f) => vm.verifyTotp(f.get('code')))}>
      <p>{strings.setup.totpIntro}</p>
      <p className={FIELD}>
        <span>{strings.setup.secretLabel}</span>
        <code className="break-all rounded-md bg-stone-100 p-3 text-base">{enrolment?.secret}</code>
      </p>
      <a href={enrolment?.otpauthUri} className="text-teal-800 underline">
        {strings.setup.openAuthenticator}
      </a>
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
