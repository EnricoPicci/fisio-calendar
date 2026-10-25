# @fisio/testkit

Shared test tooling for API specs and web journeys: DynamoDB Local helpers with per-spec
tenants, `FaultInjectingDynamo`, fake JWTs, the in-process fetch adapter, `FakeChannel`,
`ObservableRecorder`, `TraceRecorder`, `JourneyHarness` and the journey report renderer.

- **Status:** WP0.3 delivered the DynamoDB Local helpers: `testDocumentClient()`, `freshTenant()`
  and `TEST_TABLE`, plus `@fisio/testkit/global-setup`, which creates the test table once per run
  (list it in a project's `globalSetup`). WP0.4 and WP0.8 add the rest.
- **Never here:** production code. Nothing under `apps/*/src` may import this package.
- **Depends on:** `@fisio/infra` (the table definition), `@fisio/local` (DynamoDB Local client
  and `ensureTable`), the AWS SDK DynamoDB clients; later `@fisio/domain` and `@fisio/contracts`.
- **Details:** architecture [§10.3](../../docs/architecture.md#103-isolation-and-speed-decision-18a),
  [§10.5](../../docs/architecture.md#105-headless-ui-journeys).
