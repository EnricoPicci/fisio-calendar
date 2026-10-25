// Shared test tooling (docs/architecture.md §10). WP0.3: DynamoDB Local helpers. Later work
// packages add the in-process fetch adapter, recorders, JourneyHarness, FaultInjectingDynamo,
// fake JWTs and the journey report renderer.
export { freshTenant, TEST_TABLE, testDocumentClient } from './dynamo';
