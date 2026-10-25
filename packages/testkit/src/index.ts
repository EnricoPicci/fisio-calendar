// Shared test tooling (docs/architecture.md §10). WP0.3: DynamoDB Local helpers. WP0.4: the API
// spec harness pieces (fake JWTs, FakeChannel, in-process fetch); the in-process AsyncInvoker is
// `InProcessAsyncInvoker` in @fisio/domain, which the local runtime also uses. WP0.6: the Mailpit
// reader. WP0.8 adds the recorders, JourneyHarness and the journey report renderer.
export {
  closeTestDocumentClient,
  freshTenant,
  TEST_TABLE,
  testDocumentClient,
} from './dynamo';
export { FakeChannel } from './fake-channel';
export { IN_PROCESS_ORIGIN, type InProcessApp, inProcessFetch } from './in-process-fetch';
export { MAILPIT_API, type MailpitMessage, mailpitMessage } from './mailpit';
export {
  type PublicJwk,
  type SignOptions,
  TEST_CLIENT_ID,
  TEST_ISSUER,
  TEST_JWKS_URI,
  TestTokenIssuer,
  type TokenClaims,
} from './tokens';
