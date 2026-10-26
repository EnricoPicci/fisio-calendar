// Shared test tooling (docs/architecture.md §10). WP0.3: DynamoDB Local helpers. WP0.4: the API
// spec harness pieces (fake JWTs, FakeChannel, in-process fetch); the in-process AsyncInvoker is
// `InProcessAsyncInvoker` in @fisio/domain, which the local runtime also uses. WP0.6: the Mailpit
// reader. WP0.8: the recorders, the JourneyHarness core, journey/journey$, the journey report
// renderer and the surface-coverage check.
export {
  closeTestDocumentClient,
  freshTenant,
  TEST_TABLE,
  testDocumentClient,
} from './dynamo';
export { FakeChannel } from './fake-channel';
export { IN_PROCESS_ORIGIN, type InProcessApp, inProcessFetch } from './in-process-fetch';
export {
  JourneyHarness,
  type ObservableOwner,
  type StreamObserver,
} from './journeys/harness';
export {
  defineJourneys,
  type FinishingHarness,
  type JourneyOptions,
  type JourneyResult,
} from './journeys/journey';
export { ObservableRecorder } from './journeys/observable-recorder';
export { renderJourneysReport } from './journeys/report';
export { type ResultKind, readResults, writeResult } from './journeys/results';
export {
  instrumentSurface,
  type SurfaceLog,
  surfaceMethods,
  uncoveredMembers,
  type ViewModelClass,
} from './journeys/surface';
export { renderTrace, type TraceEntry, type TraceEvent, TraceRecorder } from './journeys/trace';
export { MAILPIT_API, type MailpitMessage, mailpitMessage, mailpitMessageIdsTo } from './mailpit';
export {
  type PublicJwk,
  type SignOptions,
  TEST_CLIENT_ID,
  TEST_ISSUER,
  TEST_JWKS_URI,
  TestTokenIssuer,
  type TokenClaims,
} from './tokens';
