# @fisio/testkit

Shared test tooling for API specs and web journeys: DynamoDB Local helpers with per-spec
tenants, `FaultInjectingDynamo`, fake JWTs, the in-process fetch adapter, `FakeChannel`,
`ObservableRecorder`, `TraceRecorder`, `JourneyHarness` and the journey report renderer.

- **Status:** WP0.3 delivered the DynamoDB Local helpers: `testDocumentClient()` (one per spec
  file, closed with `closeTestDocumentClient()`), `freshTenant()` and `TEST_TABLE`, plus
  `@fisio/testkit/global-setup`, which creates the test table once per run (list it in a
  project's `globalSetup`). WP0.4 added the API spec pieces: `TestTokenIssuer` (RS256 key, JWKS,
  Cognito-shaped access tokens), `FakeChannel` and `inProcessFetch(app)`; the in-process
  `AsyncInvoker` is `InProcessAsyncInvoker` in `@fisio/domain`. The API composes them in
  `apps/api/test/harness.ts`. WP0.6 added the Mailpit reader (`mailpitMessage(id)`,
  `MAILPIT_API`) for the SMTP channel's contract spec. WP0.8 added the journey tooling
  (`src/journeys`): `ObservableRecorder`; `TraceRecorder` and `renderTrace` (numbered steps,
  redactions); the `JourneyHarness` core (`record`/`recorded`, `traced(viewModel, label)`,
  `tracedFetch`, `tracedChannel`, `given`, `advance`/`advanceTo`/`advanceTo$`, `assert`), which
  the web app extends with its actors in `apps/web/test/journeys/harness.ts`;
  `defineJourneys(create, { resultsDir })` → `journey` / `journey$`; the results files and
  `renderJourneysReport` for `docs/journeys.md`; `instrumentSurface`, `surfaceMethods` and
  `uncoveredMembers` for the surface-coverage check; and `mailpitMessageIdsTo` (also as
  `@fisio/testkit/mailpit`, without Vitest) for the Playwright binding journeys.
- **Never here:** production code. Nothing under `apps/*/src` may import this package.
- **Depends on:** `@fisio/domain` (ports), `@fisio/infra` (the table definition), `@fisio/local`
  (DynamoDB Local client and `ensureTable`), the AWS SDK DynamoDB clients, RxJS and Vitest (the
  journey tooling). Never on `apps/*`: `apps/api` has the testkit as a dev dependency, so apps
  are passed in (`inProcessFetch(app)`, view-models through the structural `ObservableOwner`).
- **Details:** architecture [§10.3](../../docs/architecture.md#103-isolation-and-speed-decision-18a),
  [§10.5](../../docs/architecture.md#105-headless-ui-journeys).
