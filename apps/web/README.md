# @fisio/web

The SPA (architecture §7): React 19 templates that only bind, view-models with RxJS, services
behind ports. Vite builds it; `pnpm dev` serves it on http://127.0.0.1:5173 with `/api` proxied
to the local API, the same-origin shape CloudFront gives it in the cloud.

```
src/app/         ViewModel base (dispose, stream tagging), useObservable, DI context (useDeps,
                 useViewModel), form binding helper, build-time config, the App shell (routes)
src/pages/       templates (.tsx): binding only — Biome refuses rxjs, useState, useEffect here
src/viewmodels/  SessionViewModel, SignInViewModel, SetupViewModel, HomeViewModel (+ FormViewModel)
src/services/    ApiClient port + OpenApiClient (openapi-fetch, typed from api.generated.ts),
                 AuthService port + LocalAuthService (emulator) + AmplifyAuthService (Cognito),
                 Storage port, JWT claims
test/support/    fakes for specs (AuthService, ApiClient, JWTs); the surface instrumentation
                 (setup file), the results directory and its global setup
test/journeys/   headless journeys J<n>-<slug>.journey.spec.ts and their harness (FisioJourney)
test/surface/    the checks over a whole run (project web-surface): surface coverage, the
                 rendering of docs/journeys.md
```

## Rules the code follows

- **Templates contain no logic.** A page reads streams with `useObservable(stream$, initial)`,
  creates its view-model with `useViewModel((deps) => new XViewModel(...))` and calls methods
  from event handlers (`onSubmit(fields => vm.method(fields.get('name')))`). No `useState`, no
  `useEffect`, no `rxjs` import (`biome.json` override).
- **View-models** extend `ViewModel`: public surface = `readonly` streams created with
  `this.stream(name, source$)` and methods returning `Promise<void>` or `void`; `dispose()`
  completes every stream. `FormViewModel` adds `busy$`/`error$` and `attempt()` for one request
  at a time. Everything shown is a stream value or a `Strings` label; `error$` is Italian text
  mapped from `ErrorCode`/`AuthErrorCode` (`viewmodels/errors.ts`); a `NetworkError` (the
  request never reached the server) reads as offline, anything else as unexpected.
- **Templates share one set of class strings** (`src/app/classes.ts`) and read passwords with
  `fields.raw()` (never trimmed), identifiers and codes with `fields.get()`.
- **Ports return Observables** (`ApiClient`, `AuthService`), so view-model specs are marble
  specs on `TestScheduler` and the headless journeys drive the real classes.
- **Session.** `SessionViewModel.accessToken$` is what the `ApiClient` subscribes to before each
  request: it refreshes silently when the token is within 30 s of expiry, shares one refresh
  between concurrent requests, and ends the session (`signedOut$`) when a refresh is refused.
  The `AuthService` owns token persistence (`LocalAuthService` in the `Storage` port; Amplify in
  its own store).
- **Build-time selection.** `VITE_AUTH=local` (the default in a dev build; a production build
  must set it, or `readConfig` refuses to start) or `amplify` with
  `VITE_COGNITO_USER_POOL_ID`/`VITE_COGNITO_CLIENT_ID`; the Amplify module is a separate chunk
  the local build never loads. `VITE_AUTH_ISSUER` overrides the emulator URL.
- **API types** come from `docs/openapi.json` through `pnpm openapi` (tools/openapi-types);
  `api.generated.spec.ts` fails while they are stale. `OpenApiClient` parses every response with
  the shared Zod schema, sends the bearer in `Authorization` (one constant, see TODOS.md on
  CloudFront OAC) and `x-amz-content-sha256` on every request that may carry a body.
- **No `StrictMode`**: its simulated unmount would dispose a view-model that is still rendered.

## Specs

`pnpm test` runs them (project `web`): view-model marbles (`src/viewmodels/*.spec.ts`), the
`ViewModel` base, the `ApiClient` against a recording fetch, `LocalAuthService` against the auth
emulator's Hono app in-process (DynamoDB Local, codes read from `FakeChannel`), the generated
types' freshness, and the template bindings and the shell (`src/pages/*.spec.tsx`,
`src/app/*.spec.tsx`; `// @vitest-environment jsdom`, Testing Library).

### Headless journeys (architecture §10.5)

`test/journeys/J<n>-<slug>.journey.spec.ts`, one per flow of the catalogue (§10.4 group H). A
journey drives the real view-models, built as the pages build them, against the real API and the
auth emulator in-process (`test/journeys/harness.ts`):

```ts
journey('J1 — invitation, one-time code, first view of the calendar', async (j) => {
  await j.invite('Anna Verdi', 'anna@example.it');         // a `given` step: one trace line
  const anna = j.client('anna@example.it');                 // a device: storage, session, API client
  const signIn = anna.open(SignInViewModel);                // as SignInPage builds it, traced
  const [step, busy] = j.record(signIn.step$, signIn.busy$); // subscribe as the template would
  await signIn.requestCode('anna@example.it');
  await signIn.confirmCode(j.emails.codeFor('anna@example.it', j)); // redacted in the trace
  expect(busy.values).toEqual([false, true, false, true, false]);
  expect(j.trace.apiCalls()).toEqual(['POST /api/v1/admin/clients']);
  await anna.dispose();                                     // fails if a subscription stays open
});
```

- **Actors:** `j.client(email)`, `j.therapist()`; `actor.signIn()` / `signIn$()` run the
  sign-in page's flow; `actor.open(Class)` builds a page's view-model (add new pages to `PAGES`
  in the harness); `actor.dispose()` / `dispose$()`.
- **Setup:** `j.invite(name, email)` (through `POST /admin/clients`), `j.seedClient(...)`,
  `j.therapistAccount()`, any `j.given(text, body)`. **Time:** `j.advance(...)`,
  `j.advanceTo(...)` / `advanceTo$`, `j.tick()`. **Assertions:** `j.record`, `j.recorded`,
  `j.trace` (`apiCalls()`, `calls()`, `openSubscriptions()`), `j.emails`, `j.assert` (pipelines).
- Each journey gets a fresh tenant, channel and clock; after the body every actor is disposed and
  an open subscription fails the journey. Its rendered trace goes to `docs/journeys.md`.

### Surface coverage and the journey report

A setup file (`test/support/surface-setup.ts`) wraps the methods of every class in
`src/viewmodels` and the base's `stream()`, so each spec file logs which members it called or
subscribed to. The `web-surface` project (`vitest.surface.config.ts`) runs after every other
project and fails when a public method or stream of a view-model is exercised by no view-model
spec or journey (`test/surface/allowlist.ts`, kept empty), then renders `docs/journeys.md` from
the journeys' traces. Both need the whole web project in the run (`pnpm test`); a filtered run
of the web project fails them with that hint. CI fails when the committed `docs/journeys.md`
differs from the rendered one: commit it with the change that altered a flow.

## Pages (M0)

`/` shows, by `SessionViewModel.page$`: loading, the sign-in page (client code flow, therapist
password + TOTP), the client home (empty bookings, calendar placeholder) or the therapist home.
`/setup#email=…&code=…` is the therapist's one-time setup from the bootstrap link: password,
then TOTP enrolment, then home.

Two guards live in the view-models, so they hold whatever `AuthService` is behind the port: the
therapist signs in only through a TOTP step (`SignInViewModel` refuses tokens naming her that a
password alone or the client code flow produced, and signs the provider out), and a refresh that
hands over another user's tokens (someone else signed in on a shared phone meanwhile) ends the
session instead of carrying their bearer under the old name (`SessionViewModel`).
