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
test/support/    fakes for specs (AuthService, ApiClient, JWTs); test/journeys arrives in WP0.8
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

## Pages (M0)

`/` shows, by `SessionViewModel.page$`: loading, the sign-in page (client code flow, therapist
password + TOTP), the client home (empty bookings, calendar placeholder) or the therapist home.
`/setup#email=…&code=…` is the therapist's one-time setup from the bootstrap link: password,
then TOTP enrolment, then home.
