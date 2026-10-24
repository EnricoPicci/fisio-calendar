# @fisio/testkit

Shared test tooling for API specs and web journeys: DynamoDB Local helpers with per-spec
tenants, `FaultInjectingDynamo`, fake JWTs, the in-process fetch adapter, `FakeChannel`,
`ObservableRecorder`, `TraceRecorder`, `JourneyHarness` and the journey report renderer.

- **Status:** empty until WP0.3; filled in by WP0.3, WP0.4 and WP0.8.
- **Never here:** production code. Nothing under `apps/*/src` may import this package.
- **Will depend on:** `@fisio/domain`, `@fisio/contracts`.
- **Details:** architecture [§10.3](../../docs/architecture.md#103-isolation-and-speed-decision-18a),
  [§10.5](../../docs/architecture.md#105-headless-ui-journeys).
