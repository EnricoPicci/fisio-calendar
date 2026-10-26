import { type ApiHarness, apiHarness, emulatorTokens, SPEC_NOW } from '@fisio/api/testing';
import { createEmulatorApp } from '@fisio/auth-emulator';
import { otpCodeIn, totpCode } from '@fisio/auth-emulator/testing';
import { ClientIdSchema, type Role, stringsIt } from '@fisio/contracts';
import { FixedClock, type OutboundMessage } from '@fisio/domain';
import {
  defineJourneys,
  FakeChannel,
  type FinishingHarness,
  IN_PROCESS_ORIGIN,
  inProcessFetch,
  JourneyHarness,
} from '@fisio/testkit';
import { defer, firstValueFrom, type Observable } from 'rxjs';
import type { AppDeps } from '../../src/app/deps';
import type { ViewModel } from '../../src/app/view-model';
import { OpenApiClient } from '../../src/services/api-client';
import { LocalAuthService } from '../../src/services/local-auth-service';
import { MemoryStorage } from '../../src/services/storage';
import { HomeViewModel } from '../../src/viewmodels/HomeViewModel';
import { SessionViewModel } from '../../src/viewmodels/SessionViewModel';
import { SetupViewModel } from '../../src/viewmodels/SetupViewModel';
import { SignInViewModel } from '../../src/viewmodels/SignInViewModel';
import { resultsDir } from '../support/results';

/**
 * The web app's `JourneyHarness` (docs/architecture.md §10.5), in one Node process: the real
 * view-models; per actor the real `LocalAuthService` against the auth emulator's app and the
 * real `OpenApiClient` against the API's Hono app, both in-process; the API spec harness behind
 * them (DynamoDB Local under a fresh tenant, the notifier behind the in-process invoker); one
 * `FakeChannel` for every email, the emulator's codes included; one fixed clock for all of it.
 *
 * - `j.client(email)` / `j.therapist()`: an actor, a device of its own (storage, session, API
 *   client) as `main.tsx` composes it; `signIn()` runs the real sign-in page's view-model.
 * - `actor.open(ViewModelClass)`: the view-model a page would build, traced under
 *   `<actor>.<page>`; `actor.dispose()` disposes them like an unmount and checks that nothing
 *   is still subscribed.
 * - `j.given(text, body)`, `j.invite(…)`, `j.seedClient(…)`: setup steps, one line each in the
 *   rendered trace. `j.tick()`: the scheduler's tick at the clock's instant.
 */
/**
 * The API specs' fixed instant, where every journey starts. Setting up the therapist's account
 * moves the clock 30 s on (the enrolment used the current TOTP code; see `therapistAccount`).
 */
export const JOURNEY_NOW = SPEC_NOW;
export const THERAPIST_EMAIL = 'terapista@example.it';
export const THERAPIST_PASSWORD = 'password-della-terapista';

const TEMPLATES: Readonly<Record<string, string>> = {
  AUTH_OTP: 'one-time code',
  INVITE: 'invitation',
};

/** How a page builds its view-model (`useViewModel` in `src/pages`), by class. */
const PAGES = new Map<abstract new (...args: never[]) => ViewModel, (deps: AppDeps) => ViewModel>([
  [SignInViewModel, (d) => new SignInViewModel(d.auth, d.session, d.strings)],
  [SetupViewModel, (d) => new SetupViewModel(d.auth, d.session, d.strings)],
  [HomeViewModel, (d) => new HomeViewModel(d.api, d.strings)],
]);

export class FisioJourney extends JourneyHarness implements FinishingHarness {
  readonly stack: ApiHarness;
  readonly channel: FakeChannel;
  readonly emails: Emails;
  readonly authFetch: typeof fetch;
  readonly #actors = new Map<string, Actor>();
  #therapistSecret: Promise<string> | undefined;

  constructor() {
    const clock = new FixedClock(JOURNEY_NOW);
    super(clock);
    this.channel = this.tracedChannel(new FakeChannel(), templateOf);
    this.stack = apiHarness({ clock, channel: this.channel, tokens: emulatorTokens });
    const { emulator, config } = this.stack.emulator;
    this.authFetch = inProcessFetch(createEmulatorApp(emulator, config));
    this.emails = new Emails(this.channel);
    this.redact(THERAPIST_PASSWORD, 'password');
  }

  /** The client signing in with `email`, on a device of their own. */
  client(email: string): ClientActor {
    const name = email.split('@')[0] ?? email;
    return this.#actor(name, () => new ClientActor(this, name, email)) as ClientActor;
  }

  therapist(): TherapistActor {
    return this.#actor('therapist', () => new TherapistActor(this, 'therapist')) as TherapistActor;
  }

  /** The therapist adds a client through the API, which sends the invitation (WP0.6). */
  invite(name: string, email: string): Promise<void> {
    return this.given(`the therapist adds ${name} <${email}>`, async () => {
      const therapist = await this.therapist().signIn();
      await firstValueFrom(therapist.api.addClient({ name, email }));
      await this.stack.invoker.settled();
    });
  }

  /** A client who accepted the invitation earlier: identity user and `enabled` client item. */
  seedClient(name: string, email: string): Promise<void> {
    return this.given(`${name} <${email}> is an enabled client`, async () => {
      const user = await this.stack.identity.createUser({ email, role: 'client' });
      await this.stack.clients.put(this.stack.tenantId, {
        clientId: ClientIdSchema.parse(user.userId),
        name,
        email,
        status: 'enabled',
        locale: 'it',
        createdAt: this.clock.now().toISOString(),
      });
    });
  }

  /**
   * The therapist's account as `pnpm bootstrap:therapist` and the setup link leave it: TOTP
   * preference, Settings item, password and an enrolled authenticator. Returns the TOTP secret.
   */
  therapistAccount(): Promise<string> {
    this.#therapistSecret ??= this.given(
      "the therapist's account is set up (bootstrap, setup link used)",
      async () => {
        const { identity, settings, emulator, tenantId } = this.stack;
        const user = await identity.createUser({ email: THERAPIST_EMAIL, role: 'therapist' });
        await identity.setTotpPreference(user.userId, { enabled: true, preferred: true });
        await settings.create(tenantId, this.clock.now());
        const setupCode = await identity.startPasswordSetup(user.userId);
        const { secret } = await emulator.completeSetup(setupCode, THERAPIST_PASSWORD);
        // The enrolment used the current code; an authenticator shows the next one.
        this.advance({ seconds: 30 });
        return secret;
      },
    );
    return this.#therapistSecret;
  }

  /** The authenticator's current code, redacted in the trace. */
  async totp(): Promise<string> {
    return this.redact(
      await totpCode(this.clock, await this.therapistAccount()),
      'authenticator code',
    );
  }

  /** The scheduler's tick at the clock's instant (`pnpm tick --now`), waiting for delivery. */
  async tick(): ReturnType<ApiHarness['tick']> {
    this.trace.add({ kind: 'tick', at: this.clock.now().toISOString() });
    return this.stack.tick();
  }

  /** Time travel in a pipeline journey: the clock moves, then the tick runs (§10.5). */
  override advanceTo$(instant: Date | string): Observable<void> {
    return defer(async () => {
      this.advanceTo(instant);
      await this.tick();
    });
  }

  /** Disposes every actor, then fails naming every subscription still open, any actor's included. */
  async finish(): Promise<void> {
    await this.trace.hidden(async () => {
      for (const actor of this.#actors.values()) await actor.dispose(false);
    });
    const open = this.trace.openSubscriptions();
    if (open.size > 0) {
      throw new Error(`Subscriptions still open after dispose: ${[...open.keys()].join(', ')}`);
    }
  }

  #actor(name: string, create: () => Actor): Actor {
    let actor = this.#actors.get(name);
    if (!actor) {
      actor = create();
      this.#actors.set(name, actor);
    }
    return actor;
  }
}

/** One person on one device: the services `main.tsx` builds, and the pages they open. */
export abstract class Actor {
  readonly name: string;
  readonly auth: LocalAuthService;
  readonly api: OpenApiClient;
  /** The app-scoped session, traced as `<actor>.session`. */
  readonly session: SessionViewModel;
  readonly deps: AppDeps;
  protected readonly j: FisioJourney;
  readonly #ready: Promise<void>;
  readonly #opened: ViewModel[] = [];
  #disposed = false;

  constructor(j: FisioJourney, name: string) {
    this.j = j;
    this.name = name;
    const { config } = j.stack.emulator;
    this.auth = new LocalAuthService({
      issuer: config.issuer,
      fetch: j.tracedFetch(j.authFetch, 'auth', new URL(config.issuer).pathname),
      storage: new MemoryStorage(),
    });
    const session = new SessionViewModel(this.auth, j.clock);
    this.session = j.traced(session, `${name}.session`);
    this.api = new OpenApiClient({
      fetch: j.tracedFetch(j.stack.fetch, 'api'),
      baseUrl: `${IN_PROCESS_ORIGIN}/api/v1`,
      accessToken$: session.accessToken$,
    });
    // View-models get the session itself, so its use by them is not a step of the journey.
    this.deps = { api: this.api, auth: this.auth, session, strings: stringsIt, clock: j.clock };
    // App start (`main.tsx`): resume a sign-in kept on this device, if any.
    this.#ready = this.session.restore();
  }

  /** The view-model the page of this class builds, traced as `<actor>.<page>`. */
  open<V extends ViewModel>(cls: abstract new (...args: never[]) => V): V {
    const create = PAGES.get(cls);
    if (!create) throw new Error(`open(): no page builds ${cls.name}; add it to PAGES`);
    const viewModel = create(this.deps) as V;
    this.#opened.push(viewModel);
    return this.j.traced(viewModel, `${this.name}.${pageLabel(cls.name)}`);
  }

  /**
   * Every page unmounted and the app closed: throws when a subscription stays open, unless
   * `check` is false (`finish()` disposes every actor first, then checks them all at once).
   */
  async dispose(check = true): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#ready;
    this.j.trace.add({ kind: 'dispose', target: this.name });
    for (const viewModel of this.#opened) viewModel.dispose();
    this.deps.session.dispose();
    const open = this.j.trace.openSubscriptions(this.name);
    this.j.trace.add({ kind: 'disposed', target: this.name, open: open.size });
    if (check && open.size > 0) {
      throw new Error(`${this.name}: subscriptions still open: ${[...open.keys()].join(', ')}`);
    }
  }

  abstract signIn(): Promise<this>;

  /** `signIn()` as a step of a pipeline journey (`journey$`). */
  signIn$(): Observable<this> {
    return defer(() => this.signIn());
  }

  /** `dispose()` as the last step of a pipeline journey. */
  dispose$(): Observable<void> {
    return defer(() => this.dispose());
  }

  protected async ready(): Promise<void> {
    await this.#ready;
  }

  /** After a sign-in flow: the session names `role`, or the flow's error text is the failure. */
  protected async expectSignedIn(role: Role, signIn: SignInViewModel): Promise<void> {
    const page = await firstValueFrom(this.deps.session.page$);
    if (page === role) return;
    const error = await firstValueFrom(signIn.error$);
    throw new Error(`${this.name} is not signed in as ${role} (page ${page}): ${error}`);
  }
}

export class ClientActor extends Actor {
  readonly email: string;

  constructor(j: FisioJourney, name: string, email: string) {
    super(j, name);
    this.email = email;
  }

  /** The client code flow on the sign-in page, the code read from the email. */
  async signIn(): Promise<this> {
    await this.ready();
    const signIn = this.open(SignInViewModel);
    await signIn.requestCode(this.email);
    await signIn.confirmCode(this.j.emails.codeFor(this.email, this.j));
    await this.expectSignedIn('client', signIn);
    signIn.dispose();
    return this;
  }
}

export class TherapistActor extends Actor {
  /**
   * Password, then the authenticator code, on the sign-in page. Once signed in it does nothing:
   * at a fixed clock the authenticator would show the code already used, which is refused.
   */
  async signIn(): Promise<this> {
    await this.j.therapistAccount();
    await this.ready();
    if ((await firstValueFrom(this.deps.session.page$)) === 'therapist') return this;
    const signIn = this.open(SignInViewModel);
    signIn.showTherapistSignIn();
    await signIn.signInWithPassword(THERAPIST_EMAIL, THERAPIST_PASSWORD);
    await signIn.confirmTotp(await this.j.totp());
    await this.expectSignedIn('therapist', signIn);
    signIn.dispose();
    return this;
  }
}

/** The emails `FakeChannel` accepted, by recipient. */
export class Emails {
  readonly #channel: FakeChannel;

  constructor(channel: FakeChannel) {
    this.#channel = channel;
  }

  to(address: string): readonly OutboundMessage[] {
    return this.#channel.sentTo(address);
  }

  /** The one-time code of the latest code email to `address`, redacted in the trace. */
  codeFor(address: string, j: JourneyHarness): string {
    const message = this.to(address).findLast((m) => m.notificationKey.startsWith('AUTH_OTP#'));
    return j.redact(otpCodeIn(message), 'one-time code');
  }
}

function templateOf(message: OutboundMessage): string {
  const prefix = message.notificationKey.split('#')[0] ?? '';
  return TEMPLATES[prefix] ?? prefix.toLowerCase();
}

/** `SignInViewModel` → `signIn`. */
function pageLabel(className: string): string {
  const base = className.replace(/ViewModel$/, '');
  return base.charAt(0).toLowerCase() + base.slice(1);
}

export const { journey, journey$ } = defineJourneys(() => new FisioJourney(), {
  resultsDir: resultsDir(),
});
