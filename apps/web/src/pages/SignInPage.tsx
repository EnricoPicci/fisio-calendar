import type { Strings } from '@fisio/contracts';
import { useDeps, useViewModel } from '../app/deps';
import { onSubmit } from '../app/forms';
import { useObservable } from '../app/use-observable';
import { type SignInStep, SignInViewModel } from '../viewmodels/SignInViewModel';

/**
 * The sign-in page (docs/architecture.md §7.2): binding only. The view-model's `step$` picks the
 * form; every form reads its fields on submit and calls one view-model method.
 */
export function SignInPage() {
  const { strings } = useDeps();
  const vm = useViewModel((deps) => new SignInViewModel(deps.auth, deps.session, deps.strings));
  const step = useObservable(vm.step$, 'email');
  const busy = useObservable(vm.busy$, false);
  const error = useObservable(vm.error$, null);
  const Form = FORMS[step];
  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-2xl font-semibold">{strings.auth.title}</h1>
      <Form vm={vm} busy={busy} strings={strings} />
      {error ? (
        <p role="alert" className="mt-4 text-red-700">
          {error}
        </p>
      ) : null}
    </main>
  );
}

interface FormProps {
  readonly vm: SignInViewModel;
  readonly busy: boolean;
  readonly strings: Strings;
}

const FORMS: Record<SignInStep, (props: FormProps) => React.ReactElement> = {
  email: EmailForm,
  code: CodeForm,
  password: PasswordForm,
  totp: TotpForm,
};

const FORM = 'mt-6 flex flex-col gap-4';
const FIELD = 'flex flex-col gap-1';
const INPUT = 'rounded-md border border-stone-300 px-3 py-3 text-lg';
const BUTTON =
  'rounded-md bg-teal-700 px-4 py-3 text-lg font-medium text-white disabled:opacity-50';
const LINK = 'text-teal-800 underline';

function EmailForm({ vm, busy, strings }: FormProps) {
  return (
    <form className={FORM} onSubmit={onSubmit((f) => vm.requestCode(f.get('email')))}>
      <label className={FIELD}>
        <span>{strings.auth.emailLabel}</span>
        <input name="email" type="email" autoComplete="email" required className={INPUT} />
      </label>
      <button type="submit" disabled={busy} className={BUTTON}>
        {strings.auth.requestCode}
      </button>
      <button type="button" className={LINK} onClick={() => vm.showTherapistSignIn()}>
        {strings.auth.therapistLink}
      </button>
    </form>
  );
}

function CodeForm({ vm, busy, strings }: FormProps) {
  return (
    <form className={FORM} onSubmit={onSubmit((f) => vm.confirmCode(f.get('code')))}>
      <p>{strings.auth.codeSent}</p>
      <label className={FIELD}>
        <span>{strings.auth.codeLabel}</span>
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          className={INPUT}
        />
      </label>
      <button type="submit" disabled={busy} className={BUTTON}>
        {strings.auth.confirmCode}
      </button>
      <button type="button" className={LINK} onClick={() => vm.showClientSignIn()}>
        {strings.auth.changeEmail}
      </button>
    </form>
  );
}

function PasswordForm({ vm, busy, strings }: FormProps) {
  return (
    <form
      className={FORM}
      onSubmit={onSubmit((f) => vm.signInWithPassword(f.get('email'), f.get('password')))}
    >
      <label className={FIELD}>
        <span>{strings.auth.emailLabel}</span>
        <input name="email" type="email" autoComplete="username" required className={INPUT} />
      </label>
      <label className={FIELD}>
        <span>{strings.auth.passwordLabel}</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={INPUT}
        />
      </label>
      <button type="submit" disabled={busy} className={BUTTON}>
        {strings.auth.continueWithPassword}
      </button>
      <button type="button" className={LINK} onClick={() => vm.showClientSignIn()}>
        {strings.auth.clientLink}
      </button>
    </form>
  );
}

function TotpForm({ vm, busy, strings }: FormProps) {
  return (
    <form className={FORM} onSubmit={onSubmit((f) => vm.confirmTotp(f.get('code')))}>
      <label className={FIELD}>
        <span>{strings.auth.totpLabel}</span>
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          className={INPUT}
        />
      </label>
      <button type="submit" disabled={busy} className={BUTTON}>
        {strings.auth.confirmTotp}
      </button>
      <button type="button" className={LINK} onClick={() => vm.showTherapistSignIn()}>
        {strings.common.cancel}
      </button>
    </form>
  );
}
