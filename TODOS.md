# TODOS

## Notifications

### WhatsApp channel option

**What:** A `WhatsAppChannel` adapter (Meta Cloud API, or Twilio as fallback) behind the existing `NotificationChannel` interface, Italian Utility templates approved by Meta, per-client opt-in with recorded consent, a WhatsApp message counter on the therapist dashboard, and an authenticated entry point for delivery-status webhooks.

**Why:** The original brief wanted WhatsApp reminders and cancellations; v1 ships email only. The architecture keeps the seam (`channels` and `consentAt` on the client, one outbox item per channel, the delivery state machine) so this is additive.

**Context:** `docs/architecture.md` §12.1 holds the verified cost facts (Italy Utility rate €0.0248 per delivered message as of the July 2026 rate card; ≈ €11/month if enabled for all ~200 clients, ≈ €3.5 at 30 % opt-in) and the prerequisites with lead time: Meta Business account and business verification, a phone number dedicated to the API (not the therapist's personal number), display-name and template approval, a payment method. Meta becomes a GDPR processor with non-EU transfers, hence opt-in per client. Start with the Meta account and number; the code is the small part. Webhooks need their own authenticated entry point because the API sits behind CloudFront OAC (§9.2).

**Effort:** M
**Priority:** P3
**Depends on:** v1 launched; the therapist's decision on who pays per message and whether reminders or only cancellations go through WhatsApp.

### Notifier edge cases from the WP0.2 review

**What:** Handle these remaining cases when the notifier applies the delivery state machine:
- Do not raise the therapist alert (the FAIL email, WP2.5) for the therapist's own FAIL, alert or DIGEST notifications, so a broken SES account does not loop; rely on the failed-notifications alarm instead.
- Redact provider error text before it reaches `markFailedAttempt`. The SMTP and SES adapters already reduce it to `SMTP <code> at <command>` / `SES <error name>`; any future adapter must do the same, and the notifier should cap or classify unknown error text instead of storing it (it is shown on the dashboard).
- A manual retry (T9) of a failure older than about a month leaves the item in its creation-month partition, which deliver-due no longer queries (§6.3), so it never sends and never alerts. Re-home the item to the current month in the retry use case, or refuse the retry with an error code.
- Keep the notifier Lambda timeout plus SES SDK retries well under `SENDING_STALE_AFTER_MINUTES` (an infra assertion, WP0.9), or the sweep re-queues a send that is still running and the email goes out twice.
- A confirmation or reminder still in back-off can go out after the booking or slot was cancelled. Give items an expiry or a superseded check so `startDelivery` callers skip obsolete messages; cover it with a journey (cancel while CONF is in back-off: exactly one CANC, no later CONF).

**Why:** Each one is correct in the pure domain but fails at the integration boundary.

**Context:** Red-team findings from the WP0.2 `/ship` review. WP0.6 closed the rest: the late-result fence on `updatedAt`, `REMOVE` of dropped attributes, schema parsing at the repository boundary (corrupt items are logged and skipped), the per-item sweep re-check, the `markSent` id guard, and SES error classification per error name.

**Effort:** M
**Priority:** P2
**Depends on:** WP1.3 (CONF/CANC), WP2.5 (FAIL alert), WP0.9 (infra assertions).

### Validate template params when the outbox item is written

**What:** Check a notification's `params` against its template's schema in `NotificationRepository.newItem` (export a `validateTemplateParams(template, params)` from `packages/contracts/src/templates.ts`), so a mismatch fails the use case's transaction instead of the delivery.

**Why:** `newItem` only checks `params` as a record. A bad param is found by the notifier after the API answered 201: the item goes straight to `failed` and the client never gets the email. The invitation's bounds match `AddClientRequest` today; confirmations and reminders built from booking data will not be checked that way.

**Context:** Red-team finding in the WP0.6 `/review`. Lands best with WP1.3, the second template.

**Effort:** S
**Priority:** P2
**Depends on:** WP1.3.

### Corrupt notification items need a terminal state

**What:** Move an item that fails its schema to `failed` (a conditional update that only needs the key) and raise the `notification_failed` alert once, or make the failed-notifications alarm (WP2.7) count `notification_corrupt` as well.

**Why:** Since WP0.6 a corrupt item is logged and skipped on every path, but it stays `pending` or `sending`: it is logged again every 15 minutes for two months and the therapist is never told that the client's email will not arrive.

**Context:** Red-team and adversarial findings in the WP0.6 `/review`. Corrupt items can only come from a bug or a hand edit, hence P3.

**Effort:** S
**Priority:** P3
**Depends on:** WP2.7 (alarm), WP2.5 (FAIL email).

### Erasure must reach the NOTIFICATION copies

**What:** When client erasure lands (§9), purge or redact the client's NOTIFICATION items too: each stores `to` and the template `params` (name, email) for 180 days in month partitions, with no index by `clientId`. Either a sparse GSI on `clientId`, a six-month partition scan in the erasure use case, or storing only `clientId` and resolving the address at send time.

**Why:** Otherwise erased clients' addresses survive in the outbox until TTL.

**Context:** Red-team finding in the WP0.6 `/review`; decide before the first non-invitation template multiplies the copies.

**Effort:** M
**Priority:** P2
**Depends on:** the erasure work package.

### A client's first sign-in turns `invited` into `enabled`

**What:** Decide and implement when a client created by `POST /admin/clients` (status `invited`, WP0.6) becomes `enabled`: on the first successful email-OTP sign-in (a Cognito post-authentication trigger in the cloud, the same hook in the auth emulator), or on first `GET /me`. Add the error-code and spec rows to architecture §10.4.

**Why:** WP0.6 creates the client as `invited` with an identity user and sends the invitation, but nothing moves the status on, and the client-status middleware treats `invited` and `enabled` differently. Journey J1 (WP0.8) needs the transition.

**Context:** Found while implementing WP0.6; out of its scope (CLAUDE.md: never widen a work package).

**Effort:** S
**Priority:** P1
**Depends on:** WP0.6; needed by WP0.8.

## API

### Slot ids through CloudFront and the SPA client

**What:** Add a `dev` smoke step that sends `POST /api/v1/...{slotId}` with `SlotId.toPathSegment(id)` (`%3A`, `%23`) through CloudFront and checks the route receives the same id; make the SPA `ApiClient` build every slot path with `SlotId.toPathSegment`.

**Why:** WP0.4 proved the encoding round-trips in-process (`apps/api/test/slot-id-path.spec.ts`); CloudFront normalisation or the Function URL's SigV4 canonical path could still re-encode or decode `%23`, which only the cloud shows.

**Context:** Rest of the WP0.2 red-team finding "Slot ids in URL paths", whose domain and route half landed in WP0.4.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.7 (ApiClient), WP0.10 (dev smoke).

### Domain time errors with their request path

**What:** When the rules and range endpoints arrive, have their use cases raise `ApiError('validation_failed', { errors })` with the offending field when a domain time helper refuses an input, and cover it with an endpoint spec (a rule that starts at 02:30 on 2027-03-28). If a time zone ever comes from a request or the database, decide whether `InvalidTimeZoneError` becomes `validation_failed`. When a repository first parses a stored slot id or local date/time, wrap its domain errors (e.g. in a `CorruptItemError`) so the by-name fallback in `apps/api/src/http/problem.ts` cannot turn a corrupt database item into an unlogged 400 instead of a logged 500; cover it with a spec that stores a bad slot id.

**Why:** WP0.4's error mapper turns `NonexistentLocalTimeError`, `InvalidLocalValueError` and `InvalidSlotIdError` into `validation_failed` by name, but it cannot know the path, so the SPA cannot highlight the field. `InvalidTimeZoneError` maps to `internal_error` today, because no request carries a zone and the error means the runtime lacks tz data (the API also refuses to start then).

**Context:** Rest of WP0.2 follow-up 26 ("Map domain time errors to `validation_failed`").

**Effort:** S
**Priority:** P3
**Depends on:** WP1.1 (rules endpoints).

### OpenAPI components without a route

**What:** If the SPA needs a schema in `docs/openapi.json` before a route uses it, register it without `OpenAPIRegistry.register()`, or make `@hono/zod-openapi` and our packages load the same Zod build.

**Why:** `register()` calls the `.openapi()` method that `zod-to-openapi` adds to Zod's prototype; it patched the CommonJS copy of Zod while `@fisio/contracts` uses the ESM copy, so `register()` threw. Schemas named with `.meta({ id })` and used by a route are fine, and that is all WP0.4 needs.

**Context:** Found in WP0.4 while generating the document (Zod's dual-package hazard).

**Effort:** S
**Priority:** P4
**Depends on:** WP0.7 (generated SPA types), only if needed.

### Bounds for date ranges and the booking horizon

**What:** Decide where range limits live: a maximum span for `from`/`to` query pairs (calendar views, the therapist's slot list), a booking horizon (how far ahead a client may book), and `from <= to`. Put the shared limits in `packages/contracts` next to `IsoDateSchema`, and the business ones (horizon) in the domain.

**Why:** `IsoDateSchema` accepts any real date from 1900 to 9999, so a request for a 8,000-year range is valid today and would make the API generate or query millions of days.

**Context:** WP0.2 follow-up 14 (adversarial review). Nothing reads a range before WP0.4/WP1.x.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.4.

### Time edges and zones from the WP0.2 follow-up review

**What:** Three edges in `packages/domain/src/time.ts` and `notification-state.ts`, none reachable today:
- The year range does not line up across zones: `localDateTimeToUtc('1900-01-01', '00:30')` gives `1899-12-31T23:30Z`, which `IsoDateTimeSchema` refuses, and `localDateOf` of `9999-12-31T23:30Z` is `10000-01-01`. Narrow the supported dates (for example 1900-01-02 to 9999-12-30) or derive the instant bounds from the local ones.
- `requireTimeZone` caches each raw spelling (`europe/rome`, `EUROPE/ROME`) without a bound and accepts fixed offsets such as `+01:00`, which ignore summer time. Cache the resolved canonical name, and decide whether fixed-offset zones are refused, before a zone ever comes from a request or the database.
- Zones with sub-minute offsets after 1900 (for example `Africa/Monrovia` in 1950, −00:44:30) get a silently wrong instant from `localDateTimeToUtc`: the round-trip check reads through the same tz engine and accepts it. Restrict the zone to whole-minute zones (or Rome only), or check the round-trip against `Intl` directly. The `MIN_YEAR` comment holds for Rome only.
- `FixedClock`'s offset check looks only at the end of the string, so V8's legacy formats such as `'March 28 2027 09:00 +01:00'` pass. They are host-independent, but if specs should use canonical ISO only, anchor the whole pattern.
- `classifyError` treats anything named `PermanentError` as permanent and does not look at `cause`. Settle in the WP0.6 adapter contract which wrappers may set that name, and whether a wrapped `PermanentError` cause counts.

**Why:** Each is correct for today's only caller (the fixed Europe/Rome zone, no adapters yet) but turns into a 500, unbounded memory or wrong retries once later work packages feed it other input.

**Context:** Claude adversarial review in the `/ship` of the WP0.2 follow-up PR.

**Effort:** S
**Priority:** P3
**Depends on:** WP0.4 (zone or date input from requests), WP0.6 (channel adapters).

### Location header and retried adds on `POST /admin/clients`

**What:** Decide the pattern for 201 responses before the next create endpoint: a `Location` header (declared in the OpenAPI route) or a recorded "no Location" rule in §5.2. Also make a retried add after a lost response recognisable: the `client_exists` problem can carry the existing `clientId` (therapist-only route), or the WP1.5 clients view-model reloads the list on 409.

**Why:** `POST /admin/clients` (WP0.6) is the first 201. A phone that loses the response and retries gets 409 for a client that was in fact created.

**Context:** API-contract findings in the WP0.6 `/review`.

**Effort:** S
**Priority:** P3
**Depends on:** WP1.5.

### A double tap can answer `client_exists` with no client written

**What:** `addClient` turns `ClientItemBusyError` (the transaction was cancelled with `TransactionConflict`) into `client_exists`, trusting that the other add will commit. DynamoDB does not promise that one of two conflicting transactions wins. If both are cancelled, both answers are 409 and there is no client item and no invitation. Fix: on `ClientItemBusyError`, read the client item with a consistent read. Answer `client_exists` only if the item is there. Otherwise rethrow (a 500 the therapist can retry); the kept identity user is taken over as a left-over on the retry. Add a spec that injects the conflict with nothing committed.

**Why:** The therapist is told the client exists, the client is missing from her list, and the 409 tells her not to try again.

**Context:** Found by the red team in the WP0.6 `/ship` review (cycle 3); deferred by the user. DynamoDB Local serialises transactions, so only an injected spec can reach it.

**Effort:** S
**Priority:** P2
**Depends on:** WP1.5.

### A cancelled add can delete a user another add took over

**What:** On a `TransactionCanceledException` that is neither the `ConditionalCheckFailed` on the client item nor a `TransactionConflict` (for example throttling), `addClient` deletes the identity user it created. During a double tap the other add may already have taken that user over as a left-over, and it may still commit. The client item then points at a deleted user: the client cannot sign in, and the next add creates a second user and a second client item for the same email (GSI2 has no uniqueness). Fixes: re-read the client item before deleting (narrows the window), or never delete and let the next add take the user over (closes it, but reverses the WP0.6 "delete only on cancel" decision and leaves an unused user when nobody retries; see "Left-over identity users assume one pool per tenant").

**Why:** A client who can never sign in, plus a duplicate client record on the next add.

**Context:** Found by the red team in the WP0.6 `/ship` review (cycle 3); deferred by the user. DynamoDB Local cannot produce a throttled cancellation.

**Effort:** S
**Priority:** P2
**Depends on:** WP1.5.

### Notifier event and log helpers in their own module

**What:** `jobs/tick.ts` imports `describeError` and `NotifierEvent`, and `usecases/add-client.ts` imports `deliverEvent`, from `notify/notifier.ts`, the `Notifier` class file. Move `NotifierEventSchema`, `NotifierEvent` and `deliverEvent` to `notify/events.ts`, and `describeError` to a shared log helper, when WP1.3 adds the second use case that enqueues a delivery.

**Why:** Otherwise every use case that sends an email depends on the notifier's implementation module.

**Context:** Maintainability finding in the WP0.6 `/ship` review (cycle 3); deferred by the user.

**Effort:** S
**Priority:** P3
**Depends on:** WP1.3.

### SES `MessageRejected` for an unverified sender fails items for good

**What:** `SesEmailChannel` maps `MessageRejected` to `PermanentError` (`PERMANENT_SES_ERRORS` in `apps/api/src/notify/ses-email-channel.ts`). SES also answers `MessageRejected` when the From identity is no longer verified (DKIM or DNS drift), and on `dev` for sandbox recipients that are not verified. Every send during such a lapse goes to `failed` after one attempt and is never retried after the fix, with one `notification_failed` alarm per client. Check the SESv2 error shapes in the WP0.10 contract run on `dev`. Then either treat `MessageRejected` as retryable or tell its cases apart without storing the message text, and pin the choice in `ses-email-channel.spec.ts`.

**Why:** A configuration fault becomes a permanent delivery failure for every client written during it.

**Context:** Found by the Claude adversarial pass in the WP0.6 `/ship` review (investigate).

**Effort:** S
**Priority:** P2
**Depends on:** WP0.10.

### A short Lambda invoke on the add-client response path

**What:** `addClient` awaits `invoker.invoke('notifier', …)` before answering 201. In the cloud that is a `LambdaClient` with the default three attempts, each up to the 10 s request timeout, so a slow or throttled Invoke API can hold a response whose commit already happened until the API function or CloudFront times out, and the phone sees a 5xx. Give the API's invoker its own client with `maxAttempts: 1` and a short request timeout; the tick delivers whatever the invoke missed.

**Why:** A 5xx for a client that was in fact created, which the retry then answers with 409.

**Context:** Found by the Claude adversarial pass in the WP0.6 `/ship` review.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.9.

### `pnpm tick` reads the raw environment

**What:** `apps/api/src/runtime/tick.ts` loads `loadConfig({ ...LOCAL_DEFAULTS, ...process.env })` outside its `try`, without the `definedOnly` filter `createLocalApp` uses. A blank or foreign `STAGE`, `AUTH_ISSUER` or `WEB_ORIGIN` in the shell crashes the tick with a raw `ConfigError` stack, and `STAGE=dev` demands an https `WEB_ORIGIN` the tick never uses. Filter with `definedOnly` and load only the table fields the tick needs.

**Why:** A confusing local failure from settings the command does not use.

**Context:** Found by the Claude adversarial pass in the WP0.6 `/ship` review.

**Effort:** S
**Priority:** P3
**Depends on:** none.

### A path in `WEB_ORIGIN` is dropped without an error

**What:** `apps/api/src/config.ts` turns `WEB_ORIGIN` into `new URL(url).origin`, so `https://fisio.example/app` is accepted as `https://fisio.example` and invitation links point at the wrong place. Refuse a path, query or fragment other than `/`, with a row in `config.spec.ts`.

**Why:** A misconfigured stage sends working-looking links to the wrong address.

**Context:** Found by the Claude adversarial pass in the WP0.6 `/ship` review.

**Effort:** S
**Priority:** P3
**Depends on:** WP0.9.

## Auth

### Bearer tokens through CloudFront OAC to the Function URL

**What:** Decide how the SPA's access token reaches the `api` Lambda behind CloudFront, then make `authorize` (`apps/api/src/http/access.ts`), the SPA `ApiClient` and the CDK `App` stack agree. Options: (a) a custom header such as `x-fisio-authorization: Bearer …`, forwarded by the origin request policy, with the API reading it in the cloud; (b) a Lambda Web Function origin with OAC signing behaviour `always-amz-auth`, which keeps the viewer's `Authorization`; (c) another design. Add a `dev` smoke step that calls `GET /api/v1/me` through CloudFront with a real token.

**Why:** OAC signing behaviour `always` overwrites the viewer's `Authorization` header with CloudFront's SigV4 signature. `no-override` passes it unsigned, so the `AWS_IAM` Function URL refuses it, and `always-amz-auth` is valid only for Lambda Web Function origins (AWS docs: "Restrict access to an AWS Lambda function URL origin", `OriginAccessControlConfig.signingBehavior`). As designed (§8.2 bearer in `Authorization`, §9.1 OAC + IAM Function URL), every member and therapist route would answer 401 in `dev`/`prod`, while every local spec passes. It fails closed.

**Context:** Red-team finding in the WP0.4 `/ship` review, verified against the AWS docs. The decision touches `infra/` and the SPA, so it was deferred (CLAUDE.md: ask before changing `infra/`; never widen a WP). Architecture §9.1 carries an open-decision note.

**Effort:** S (code) once decided
**Priority:** P1
**Depends on:** Must be settled before WP0.9 (CDK `App` stack) and WP0.7 (SPA `ApiClient`).

### Email case and id format across Cognito and the auth emulator

**What:** Make sure every path that stores or compares an email uses `EmailSchema` (trimmed, lower-cased): sign-up, the therapist's client invite, Cognito `username`/`email` attributes, and the emulator. Check that the emulator issues `sub` values that `ClientIdSchema` (`z.uuid()`) accepts, the same version Cognito uses.

**Why:** Cognito treats email aliases case-insensitively only when the pool is configured so; if one path lower-cases and another does not, one person can end up with two clients, or fail to sign in. An emulator `sub` that is not a valid UUID would make local specs pass on ids production never sees, or fail on ids it does.

**Context:** WP0.2 follow-up 16 (adversarial review). `EmailSchema` and `ClientIdSchema` are in `packages/contracts/src/schemas.ts`.

**Effort:** S
**Priority:** P2
**Depends on:** The Cognito and auth-emulator work packages.

### Pin the therapist token to the stored therapist id

**What:** Store the therapist's Cognito `sub` in the tenant's Settings item when the bootstrap CLI creates it, and make `authorize` (`apps/api/src/http/access.ts`) refuse a `role: therapist` token whose `sub` differs. The item is already read on every therapist request, so only the projection changes. Add a spec: a therapist-role token with another `sub` → 403 on every protected route.

**Why:** Today any validly signed access token with `role: therapist` and the tenant id gets full `/admin/*` access, whatever its `sub`. All admin privilege rests on the pre-token-generation trigger and the Cognito attribute and group setup; one wrong write permission would let a client become the therapist with no check left in the API.

**Context:** Claude adversarial finding in the WP0.4 `/ship` review. The bootstrap CLI (`pnpm bootstrap:therapist`) and the Settings item's fields land in WP0.5 and WP1.1.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.5 (bootstrap writes the Settings item).

### Validate the issuer URL at cold start

**What:** In `loadConfig` (`apps/api/src/config.ts`), refuse an `AUTH_ISSUER` with a trailing slash and any scheme but `https:` (allowing loopback `http:` for `local` and `test`), with `config.spec.ts` cases.

**Why:** `z.url()` accepts `https://x/p/`, `http:` and `ftp:`. The derived JWKS URI drops a trailing slash but the issuer passed to the verifier keeps it, so the `iss` check fails on every token: a `JwtBaseError` outside `SERVER_FAULTS`, so every user gets an unlogged 401 — the failure the 500 rule exists to prevent.

**Context:** Claude adversarial finding in the WP0.4 `/ship` review. The CDK `App` stack sets the variable in WP0.9.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.9.

### JWKS back-off answers 401 for a new signing key

**What:** Decide how a token whose `kid` is not cached is answered while `aws-jwt-verify`'s `SimplePenaltyBox` is in its 10 s back-off (`WaitPeriodNotYetEndedJwkError`, today a 401). Either add it to `SERVER_FAULTS` in `apps/api/src/identity/token-verifier.ts` (500, so clients retry; cost: unknown-kid noise then logs as server faults and counts toward the 5xx alarm), or pass a penalty box keyed by `kid` as well as the JWKS URI. Pin the choice with a spec (unknown kid, then a valid token with a new kid inside 10 s).

**Why:** The penalty box is keyed by the JWKS URI only. An unauthenticated caller sending tokens with random `kid`s every 10 s keeps it closed, so after a Cognito key rotation (or an emulator restart with new keys) real users get 401 until the attacker stops. Cached kids are unaffected.

**Context:** Red-team finding in the WP0.4 `/ship` review, verified in `aws-jwt-verify@5.2.1` `dist/esm/jwk.js` (`SimplePenaltyBox.wait(jwksUri)`).

**Effort:** S
**Priority:** P3
**Depends on:** WP0.5 (emulator key rotation) or WP0.9.

### Warm the JWKS cache at cold start

**What:** In the Lambda composition root, start `verifier.hydrate()` at init without awaiting it at the top level, and catch its rejection so a JWKS outage still surfaces per request as a 500.

**Why:** The JWKS is fetched lazily on the first authenticated request after each cold start, adding a round trip to `cognito-idp` to a user request. With reserved concurrency 10 and low traffic, cold starts are a large share of requests.

**Context:** Performance finding in the WP0.4 `/ship` review. Measure the cold-start latency on `dev` before and after.

**Effort:** S
**Priority:** P3
**Depends on:** WP0.9 (Lambda deployed and measurable).

### Comment and doc follow-ups from the WP0.4 final review

**What:**
- `InvalidTokenError`'s docstring (`apps/api/src/identity/token-verifier.ts`) still says "for logs only"; its presence as the `ApiError` cause now picks the `Bearer error="invalid_token"` challenge.
- `bearerChallenge` (`apps/api/src/http/problem.ts`) recognises that cause by class name; set the challenge explicitly where `authorize` builds the error (or use `instanceof`), and drop "Recognised by name, like the domain errors".
- The two challenge strings are written in `problem.ts` and again in `BEARER_CHALLENGE` (`apps/api/src/http/responses.ts`); define them once and build the OpenAPI enum from it.
- Architecture §8.2 and the inline comment in `token-verifier.ts` still say only an unfetchable or unparsable JWKS is a 500; add a key that cannot verify signatures (`use`, `kty`).

**Why:** Each comment now disagrees with the code, or invites the two copies to drift; the specs pin the behaviour, so nothing is broken today.

**Context:** Maintainability findings from the final `/ship` review pass of WP0.4, deferred by the owner so the review could converge. WP0.5 edits `apps/api/src/identity/` anyway.

**Effort:** S
**Priority:** P3
**Depends on:** WP0.5.

### Case-insensitive bearer scheme

**What:** Match the `Bearer` scheme case-insensitively in `authorize` (`apps/api/src/http/access.ts`, `BEARER`), with a spec for `bearer <token>`.

**Why:** RFC 9110 §11.1 makes the auth scheme case-insensitive; a client sending `bearer` gets a 401 today. Our own SPA sends `Bearer`, so this is conformance, not a live bug.

**Context:** Claude adversarial finding in the WP0.4 `/ship` review.

**Effort:** S
**Priority:** P4
**Depends on:** None.

### Tie the bootstrap CLI's Cognito pool to its stage

**What:** Have `bootstrap:therapist --stage dev|prod` read the pool id (and the SPA origin) from the stage's stack outputs, or check the pool's name or tag against `--stage`, instead of trusting `COGNITO_USER_POOL_ID` from the shell. Ask for confirmation on `prod`.

**Why:** A prod pool id left in the shell would make `--stage dev` reset the prod therapist's setup (a new temporary password) while writing Settings to the dev table. Since WP0.5 the region comes from the pool id and `WEB_ORIGIN` must be https, but nothing ties the pool to the stage.

**Context:** Adversarial finding in the WP0.5 `/review`. The stacks and their outputs arrive in WP0.9; the first real run is WP0.10.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.9.

### Repair a Cognito user left without a role group

**What:** Have `CognitoIdentityProvider.findUserByEmail` report a user in no role group as its own state (or a typed error), and let `createUser` / `bootstrap:therapist` add the missing group, which is safe to repeat. At the least, give the "is in no role group" error the same "delete it, then retry" hint as the rollback's AggregateError.

**Why:** `createUser` rolls back only when `AdminAddUserToGroup` throws. If the process dies between the two calls, or the SDK retries an `AdminCreateUser` that Cognito already applied (`UsernameExistsException` on the retry), the user stays without a group. Every later bootstrap run then fails at its first lookup, before it could add the group, until someone deletes the user by hand. This is not the settled race (where the concurrent run's group add lands).

**Context:** Claude adversarial finding in the WP0.5 `/ship` (run 2), after the last review cycle. It matters for the one-time prod bootstrap (WP0.10).

**Effort:** S
**Priority:** P2
**Depends on:** None.

### Close the base DynamoDB clients in the CLIs

**What:** In `tools/bootstrap/src/cli.ts` and `tools/local/seed/src/seed.ts`, keep the `DynamoDBClient` the document client wraps and call `destroy()` on it. `DynamoDBDocumentClient.destroy()` is empty in lib-dynamodb 3.1146.0, so `doc.destroy()` closes nothing (the Cognito client is closed).

**Why:** Idle keep-alive sockets are unref'd, so a one-shot CLI exits today. Anything that builds these adapters repeatedly (a spec, a long-lived process) would leak them.

**Context:** Claude adversarial finding in the WP0.5 `/ship` (run 2).

**Effort:** S
**Priority:** P4
**Depends on:** None.

### Main-module check through a symlinked path

**What:** Compare `realpathSync(process.argv[1])` with `fileURLToPath(import.meta.url)` in the "run as a script" checks of `tools/bootstrap/src/cli.ts`, `tools/local/seed/src/seed.ts`, `tools/local/auth-emulator/src/server.ts` and `apps/api/src/runtime/local.ts`.

**Why:** `import.meta.url` is the real path, `argv[1]` may not be. Run from a checkout reached through a symlink, `pnpm bootstrap:therapist` and `pnpm seed` exit 0 having done nothing.

**Context:** Claude adversarial finding in the WP0.5 `/ship` (run 2); the pattern predates WP0.5 in `local.ts`.

**Effort:** S
**Priority:** P4
**Depends on:** None.

### A Cognito user without a role group blocks its email

**What:** `CognitoIdentityProvider.createUser` runs `AdminCreateUser`, then `AdminAddUserToGroup`. If the process stops between the two, or if `AdminCreateUser` committed and its retry hit `UsernameExistsException`, the result is a user with no group. `findUserByEmail` then throws "is in no role group", so every `POST /admin/clients` for that email answers 500 until someone repairs the user by hand. The fix: in `addClient`'s `identityUser`, treat a group-less user with no client item as a left-over. Either add it to the `client` group, or delete it and create it again. Alternatively, have `findUserByEmail` return `role: undefined` and let the use case decide.

**Why:** It is a permanent 500 for one address, with no self-recovery.

**Context:** Found by the red team in the WP0.6 `/ship` review. Cognito is not wired until WP0.10, so this cannot happen on the local stack.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.10 (Cognito contract target).

### Left-over identity users assume one pool per tenant

**What:** `addClient` reuses an enabled client-role identity user that has no client item in the calling tenant (a crash between `createUser` and the transaction). With two tenants on one pool, tenant B would adopt tenant A's user. Record the tenant on the identity user (custom attribute, emulator store) and require it to match, or state one-pool-per-tenant in §8 and the config. A disabled left-over user also answers `client_exists` forever.

**Why:** Safe for v1 (one tenant), wrong the day a second tenant shares the pool.

**Context:** Adversarial and red-team findings in the WP0.6 `/review`; related to "One therapist per pool".

**Effort:** S
**Priority:** P3
**Depends on:** a second tenant.

### Sign-in lockout as a denial of service

**What:** Decide how the lockout is keyed. Today five wrong codes or passwords for one email lock that email for 15 minutes, and the code and password flows share the counter. Anyone who knows an address can keep a client, or the therapist, locked out by repeating that every 15 minutes. While locked, a client asking for a code gets the normal answer and no email. Options: count per session or user, keep code failures out of the password flow, add a per-IP WAF rate rule on the sign-in endpoints, and design the SPA's "locked" message with a C1 journey.

**Why:** The rule mirrors Cognito, which also locks per user, so changing the emulator alone would make it drift from the cloud. Whatever is chosen must hold on both.

**Context:** Red-team finding in the WP0.5 `/review`. The WAF rules are WP0.9; the SPA's sign-in pages are WP0.7.

**Effort:** M
**Priority:** P3
**Depends on:** WP0.7, WP0.9.

### Refresh-token reuse grace period

**What:** Pin the app client's refresh-token rotation grace period (`RetryGracePeriodSeconds`) in WP0.9. Then either give the emulator the same window, with a contract row ("a refresh token reused within the grace period succeeds once"), or have the SPA serialise refreshes across tabs (a Web Lock or BroadcastChannel) and cover that with a journey.

**Why:** The emulator spends a refresh token on first use. Two tabs, or a retry after a timeout, that refresh with the same token sign the user out locally, while Cognito with a grace period would accept both. The SPA's refresh handling would be built against the stricter rule.

**Context:** Red-team finding in the WP0.5 `/review`.

**Effort:** S
**Priority:** P3
**Depends on:** WP0.7, WP0.9.

### The seed reconciles existing clients

**What:** Make `pnpm seed` bring an existing client back to its seeded state: enable or disable the identity to match `status`, and correct the client item, instead of skipping any client that already exists.

**Why:** A client blocked or edited by hand during local testing stays that way after a re-seed, so "a re-run changes nothing" also means "a re-run repairs nothing". `pnpm local:down && pnpm local:up` is the reset today.

**Context:** Adversarial finding in the WP0.5 `/review`.

**Effort:** S
**Priority:** P4
**Depends on:** None.

### One therapist per pool

**What:** Have `bootstrap:therapist` refuse a second therapist. Before creating a user, look for any member of the `therapist` group (a new port method: Cognito `ListUsersInGroup`, an emulator pool-level item), and refuse with `BootstrapError` when one exists under another email, unless an explicit flag replaces her. Add a contract row and a bootstrap row.

**Why:** Bootstrap is idempotent per email only. A mistyped `--email` on `prod` creates a second account with full therapist rights (the API trusts the role claim), against §1 "one therapist" and §11.5 "never duplicates".

**Context:** Red-team finding in the WP0.5 `/ship` review; deferred because it adds a port method to both adapters (never widen a WP).

**Effort:** S
**Priority:** P2
**Depends on:** WP0.10 (first real run).

### Concurrent guesses beyond the lockout

**What:** Make the emulator reserve an attempt before it checks a code (an update conditioned on no live lock and `failures < max`), and let a success clear only its own reservation, so a burst of parallel answers is held to the 5-attempt limit and a right guess inside it cannot erase the lock.

**Why:** Today every answer of a burst passes the lock check before any failure lands, so the lockout limits bursts, not guesses, and `clearAttempts` on a success deletes a lock the concurrent failures just set. The emulator only; Cognito enforces its own limits.

**Context:** Red-team finding in the WP0.5 `/ship` review. Interacts with "Sign-in lockout as a denial of service" above.

**Effort:** S
**Priority:** P3
**Depends on:** None.

### One password policy for the emulator and the pool

**What:** Write the therapist's password policy in `packages/contracts` (`MIN_PASSWORD_LENGTH` plus any character-class rules), make the emulator enforce exactly that, and pin the WP0.9 pool's `PasswordPolicy` to it (for example class requirements off if 12+ characters is the policy). Add a spec row for a long password without the classes.

**Why:** The emulator accepts any 12-character password, while Cognito's default policy also requires upper and lower case, digits and symbols: the setup page would fail only in the cloud.

**Context:** API-contract finding in the WP0.5 `/ship` review.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.9.

### Cognito exceptions onto the sign-in codes

**What:** Before the SPA's `CognitoAuthService` (WP0.7), list which Cognito exception (and challenge) maps to each `AuthErrorCode`. Where Cognito cannot tell two cases apart without its message text (an expired challenge session and a wrong password are both `NotAuthorizedException`), collapse them in the emulator too or mark the code emulator-only. Align `otpValiditySeconds` with the pool's `AuthSessionValidity` (default 3 minutes) in WP0.9.

**Why:** View-models and journeys built on the emulator's finer codes could expect outcomes the cloud adapter cannot produce.

**Context:** API-contract finding in the WP0.5 `/ship` review.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.7, WP0.9.

### Local overrides reach every local process

**What:** Load `.env.local` in `tools/scripts/dev.mjs` before it spawns the processes, and in the seed and `bootstrap:therapist --stage local`, or have them read the table and endpoint from the API's `loadConfig`.

**Why:** Only the API reads `.env.local`. With a `TABLE_NAME` or `DYNAMODB_ENDPOINT` override there, the emulator, seed and bootstrap write to a different table than the API reads, and every call answers 401/403 with no hint why.

**Context:** Red-team finding in the WP0.5 `/ship` review.

**Effort:** S
**Priority:** P4
**Depends on:** None.

### Revoke the therapist's access token

**What:** Decide whether a block or a global sign-out must also stop the therapist's access tokens already issued. Options: a stored `signedOutAt` that `authorize` (`apps/api/src/http/access.ts`) compares with the token's `auth_time`, or a shorter access-token lifetime for the therapist's app client.

**Why:** The API verifies access tokens offline, so `AdminUserGlobalSignOut` and `AdminDisableUser` end only the refresh tokens for it. Clients are covered by the per-request status check; the therapist's check only asks whether the Settings item exists, so a session opened in the password-only window, or a blocked therapist, keeps API access for up to 60 minutes.

**Context:** Red-team finding in the WP0.5 `/ship` review (cycle 2).

**Effort:** S
**Priority:** P3
**Depends on:** WP0.9.

### A spec for the bootstrap CLI's run

**What:** Let `runBootstrapCli` take its adapters (or an adapters factory), then spec exit 0 with the printed link, the "no setup link" and "re-enabled" lines, and exit 1 on a `BootstrapError`.

**Why:** Only the argument and environment checks (exit 2) are specced; the output and exit codes of the run the therapist's onboarding depends on are not.

**Context:** Testing finding in the WP0.5 `/ship` review.

**Effort:** S
**Priority:** P4
**Depends on:** None.

## Web app

### Installable PWA

**What:** Web app manifest and a minimal service worker (app-shell caching only, no offline booking) via `vite-plugin-pwa`, so clients can add the calendar to their phone's home screen.

**Why:** Clients open the calendar from phones; a home-screen icon lowers friction versus a bookmark. Removed from v1 in the eng review scope decision as tooling without launch value.

**Context:** Add after M3 once asset hashing and the CSP are stable. Keep the worker to app-shell caching and version it with the build hash so a deploy never serves a stale SPA; test on iOS Safari explicitly. No backend impact.

**Effort:** S
**Priority:** P3
**Depends on:** v1 launched.

### English UI / locale switch

**What:** A per-client `locale` attribute (default `it`, already in the data model) and an English strings module next to the Italian one in `packages/contracts/strings/`; `Intl` formatting and email templates follow the locale.

**Why:** The clarification round asked for an i18n-ready UI; the eng review replaced i18next with a typed strings module, so a second language is a second module plus a switch, not a framework.

**Context:** Only relevant if the therapist gets non-Italian-speaking clients. Email templates need translating too, and the therapist's own UI can stay Italian. A missing key in a strings module is a compile error, which keeps the two modules in step.

**Effort:** M
**Priority:** P4
**Depends on:** A real request from the therapist.

## Infrastructure

### Outbox dedup and the tick only see recent months

**What:** `NotificationRepository.newItem` refuses a taken key only inside the UTC month partition of `now`. The same deterministic key written in a later month creates a second item, and the email is sent twice. `deliverDue` and `sweep` scan only the current month and the previous one, so an item made `pending` again later is never picked up by the tick. That includes the T9 manual retry (`resetForManualRetry`) of a failure older than a month. Decide before WP1.3 reuses the repository: either a manual retry rewrites the item into the current month, or it sends a `deliver` event with the item's own ref. Use cases that may rerun across a month boundary (reminders) should check for an existing item first.

**Why:** Neither case can happen with WP0.6's invitation flow, but both become real with confirmations, reminders and manual retry.

**Context:** Found by the red team in the WP0.6 `/ship` review. The `newItem` doc comment now states the month scope.

**Effort:** S
**Priority:** P2
**Depends on:** WP1.3, T9.

### Paging of the outbox scan is untested

**What:** `NotificationRepository.#scan`, which backs `findDue` and `findSendingSince`, follows `LastEvaluatedKey` across 1 MB pages, but no spec reaches a second page. DynamoDB Local does not enforce the 1 MB page limit. The WP0.6 `/ship` probe put 1.4 MB in one partition and got a single page with no `LastEvaluatedKey`, so a spec on the local stack cannot fail when the loop breaks. Cover it in the WP0.10 cloud contract run on `dev`, with a real partition over 1 MB, or with a `Limit` that a production caller also needs.

**Why:** If the cursor handling broke, due items past the first megabyte of a busy month would silently never be sent or swept.

**Context:** Found by the testing specialist in the WP0.6 `/ship` review. The user approved a spec, but the probe showed that a local spec cannot fail.

**Effort:** S
**Priority:** P3
**Depends on:** WP0.10.

### SES throttling uses up notification attempts

**What:** The SESv2 client runs with `maxAttempts: 1` (`apps/api/src/runtime/lambda.ts`), so a send is never repeated inside the SDK, where it could deliver twice. The cost is that a throttle (`TooManyRequestsException`) or a refused connection becomes a failed notifier attempt with the 1-5-30-120 minute back-off. A burst of sends can then use up an item's attempts without a real delivery error. Fix: a custom retry strategy (`@smithy/util-retry`, a new dependency) that retries only errors raised before the request reached SES (throttle, connection refused), keeping `maxAttempts: 1` for anything sent.

**Why:** WP2.3's reminders and digest send in bursts, where SES throttling is likely.

**Context:** Found by the red team in the WP0.6 `/ship` review; deferred by the user.

**Effort:** S
**Priority:** P2
**Depends on:** WP2.3.

### A per-attempt fence for the notifier's transitions

**What:** Transitions are fenced on `status` plus `updatedAt`, at millisecond resolution. Two notifier runs that claim the same item in the same millisecond after a throttled first attempt can both pass the fence. Separately, `#recordSent` retries its `sent` write across calls: a retry that finds its own earlier commit looks like another writer and logs a false `notification_outcome_lost`. Fix: write a random nonce with each `sending` claim and fence the later transitions on it, so a write is matched to the attempt that made it.

**Why:** Both cases are rare at WP0.6's volume, but bulk sends (WP2.3) run many notifier invocations at once.

**Context:** Found by the red team in the WP0.6 `/ship` review; deferred by the user.

**Effort:** M
**Priority:** P2
**Depends on:** WP2.3.

### Notifier Lambda timeout and batch size

**What:** In the CDK App stack (WP0.9) give the notifier an explicit timeout sized for a backlog (for example 60 s), assert that timeout plus the SDK clients' request timeouts (10 s per request, `apps/api/src/runtime/lambda.ts`) stay well under `SENDING_STALE_AFTER_MINUTES`, and consider a small bounded concurrency in `Notifier.#run` (items are processed one after another, three or four round trips each).

**Why:** With the default 3 s timeout a deliver-due run with more than about ten items is cut off mid-batch; the items left in `sending` are swept as failed attempts and can reach the attempt limit without a real delivery error.

**Context:** Performance and adversarial findings in the WP0.6 `/review`; extends the infra assertion already listed under "Notifier edge cases from the WP0.2 review".

**Effort:** S
**Priority:** P1
**Depends on:** WP0.9.

### Keep tools/local out of the Lambda bundles

**What:** `apps/api` now depends on `@fisio/local` (nodemailer) and `@fisio/auth-emulator` at runtime, for the local composition root. Make the WP0.9 bundle smoke assert that no `handlers/*` bundle contains them (or a lint rule forbidding the import outside `runtime/local.ts` and `runtime/tick.ts`).

**Why:** Only tree-shaking keeps dev tooling out of the deployed functions today.

**Context:** Adversarial finding in the WP0.6 `/review`. The four dependencies were approved for WP0.6.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.9.

### Review the Claude Code allowlist before AWS credentials exist

**What:** Before WP0.10 puts AWS credentials on the developer machine, revisit `.claude/settings.json`: decide which pre-approved commands that run repo-defined code stay auto-allowed (`pnpm typecheck`/`lint`/`-r build`/`tick`/`local:up`, `docker compose up -d`, `cdk synth`/`diff`, plain `git diff`/`log`/`status` with configured drivers), and keep AWS credentials out of the default shell profile so a session cannot reach the account without a deliberate step (a named profile or `aws sso login` per session).

**Why:** The deploy gate (`.claude/hooks/block-cdk-deploy.mjs`) only reads Bash command text. A pre-approved command that runs code Claude can edit — a package script, a compose file, the CDK app, a git diff driver — can do anything without a prompt, including a deploy. No text check can close that; credentials and IAM are the real boundary. During WP0.1 there is no AWS account or CDK app, so the risk is latent.

**Context:** Recorded at the end of the WP0.1 `/ship` reviews (six adversarial rounds; decisions D4 and D5 of the second run). Options: move script-running pre-approvals to ask; require `AWS_PROFILE` to be unset in sessions; give the CI deploy role the only write access to `dev`/`prod` and make developer credentials read-only.

Known gaps in the text gate, verified in the last review round and accepted for WP0.1 (deliberate spellings, not accidents): an empty expansion spliced into a word (`dep$(true)loy`, `de${x}ploy`, ``dep``loy``, `de${x:-p}loy`), a backslash-newline inside a word, POSIX glob classes for the CLI (`c[[:alpha:]]k`), globs or brace lists for the subcommand word, `$""` locale strings, calling `@aws-cdk/toolkit-lib` from a script, and other account-changing CLIs (`aws cloudformation deploy`, `sam deploy`). A compact second reading (expansions deleted rather than spaced, line continuations joined, any word with `[` treated as the CLI) closes most of them. Edit-hook gaps from the same round: `tsc` resolved through the package's own `node_modules/.bin` can be shadowed (run the root binary by absolute path, no shell); the plain-tsc pattern accepts any flag (allowlist `--noEmit` and `-p <relative path>`); a file outside the owning package's tsconfig `include` passes silently; Biome reports ignored paths as errors (`--files-ignore-unknown=true --no-errors-on-unmatched`); `@types/node` 24 versus the Node 22 Lambda runtime; the stale "shared with the edit hook" header in `cdk-gate.mjs` and its pre-gate mapping.

**Effort:** S
**Priority:** P1
**Depends on:** WP0.10 (first AWS credentials on the machine).

### Shared packages that run under plain Node

**What:** Decide how `@fisio/domain` and `@fisio/contracts` are consumed outside Vite, Vitest and esbuild: either keep them source-only and require every runner (Lambda bundles, `tools/*` scripts, `pnpm tick`) to bundle or use a TypeScript loader, or add a build step with `exports` pointing at emitted `.js`. Cover the chosen path with the WP0.9 bundle smoke and one `tools` script run under plain `node`.

**Why:** The packages export raw `.ts` with extensionless relative imports (`./time`), which Node's type stripping does not resolve. The constructor parameter properties that also failed (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) were removed in WP0.6; `erasableSyntaxOnly` would keep them from coming back.

**Context:** WP0.2 follow-up 15 (adversarial review). Bundled Lambdas are unaffected; scripts run directly are not. WP0.4 runs its two scripts through `tsx` (`pnpm dev`, `pnpm openapi`), a root dev dependency; the WP0.9 bundle smoke and the first `tools/*` script still need the decision.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.9 (bundle smoke), or the first `tools` script that imports a package.

### Separate AWS accounts for dev and prod

**What:** Move `dev` into its own account under an AWS Organization; CDK stages target different accounts; one GitHub OIDC deploy role per account; budgets per account.

**Why:** `docs/architecture.md` §9.3 starts with one account and stage-separated stacks for a solo maintainer. Separate accounts are the standard blast-radius control: a mistake in dev cannot touch prod data, IAM or spend.

**Context:** Cheapest before `prod` holds real client data; after that it is a migration. Each account gets its own CloudFront Free plans (3), its own SES production-access request and its own Cognito pool. Target: the week after M3 launch at the latest, or before if real client data enters during M2 testing.

**Effort:** M
**Priority:** P2
**Depends on:** None technical; a decision on timing.

### API responses are never cached

**What:** Add one root middleware in `apps/api/src/http/app.ts` that sets `Cache-Control: no-store` on every API response (problem+json included), and make the CDK `App` stack name the `/api/*` behaviour's cache policy (`CachingDisabled`) in architecture §9.1, with an infra assertion.

**Why:** `GET /me` returns personal data, and neither `infra/` nor the architecture names the `/api/*` cache policy yet; a caching default in front would serve one user's profile to another. The header closes it whatever the distribution's policy turns out to be.

**Context:** Claude adversarial finding in the WP0.4 `/ship` review.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.9 (CDK `App` stack).

### Move the Lambda adapter to `@hono/aws-lambda`

**What:** Replace `hono/aws-lambda` in `apps/api/src/handlers/api.ts` with the `@hono/aws-lambda` package (a new dependency: ask first), and check in the bundle smoke that a request the adapter cannot build still answers problem+json, not plain-text `Invalid request` / `Internal Server Error`.

**Why:** `hono/aws-lambda` is marked deprecated in its own source ("will be removed in v5"). Harmless while `hono` stays on `^4`.

**Context:** Claude adversarial finding in the WP0.4 `/ship` review.

**Effort:** S
**Priority:** P3
**Depends on:** WP0.9 (bundle smoke), or the next `hono` major.

## Local stack and test harness

### Dependency direction between testkit and tools/local

**What:** Move the DynamoDB Local helpers (`localDynamoClient`, `ensureTable`, `createTableInput`, `TableDefinitionMismatchError`) out of `tools/local` into a package under `packages/` (or into `@fisio/testkit`), and make `tools/local`'s `create-table` depend on it, not the reverse. Record in `packages/README.md` which way `tools/*` and `packages/*` may depend on each other.

**Why:** WP0.3 made `@fisio/testkit` (a package) depend on `@fisio/local` (a tool). From WP0.5, `tools/local` gets the auth emulator, tick runner and seed, which run `apps/api` code, while `apps/api` takes `@fisio/testkit` as a dev dependency for its spec harness: `apps/api → testkit → tools/local → apps/api` is a workspace cycle.

**Context:** Maintainability finding from the WP0.3 `/ship` review, deferred by the owner (CLAUDE.md: never widen a work package).

**Effort:** S
**Priority:** P2
**Depends on:** WP0.5 (before `tools/local` imports `apps/api`).

### Keep every failure in `InProcessAsyncInvoker.settled()`

**What:** Make `settled()` in `packages/domain/src/ports.ts` throw an `AggregateError` when more than one invoked function failed, and track "has failed" separately from the value so a rejection with `undefined` is not dropped. Cover both in `packages/domain/test/ports.spec.ts`.

**Why:** Today it rethrows only the first failure (`const [first] = this.#failures.splice(0)`) although its doc says a failure is never lost; a journey that fires two notifier invocations would hide the second error.

**Context:** Claude adversarial finding in the WP0.4 `/ship` review. Nothing invokes it until the notifier wiring in WP0.6.

**Effort:** S
**Priority:** P3
**Depends on:** WP0.6.

### Local API defaults from their single source

**What:** Derive `LOCAL_DEFAULTS.TABLE_NAME` and `LOCAL_DEFAULTS.DYNAMODB_ENDPOINT` in `apps/api/src/runtime/local.ts` from `tableName('local')` (`infra/lib/table-definition.ts`) and `DEFAULT_LOCAL_ENDPOINT` (`tools/local/src/table.ts`), or add a spec asserting they are equal.

**Why:** The values are copied today. WP0.4 already changed the local endpoint from `localhost` to `127.0.0.1` in `tools/local`; the next such change would leave `pnpm dev` pointing at a table or host `pnpm local:up` never created.

**Context:** Maintainability finding in the WP0.4 `/ship` review. Either fix adds a workspace dependency of `apps/api` on `@fisio/infra` and `@fisio/local` (ask first, CLAUDE.md), and interacts with "Dependency direction between testkit and tools/local" above.

**Effort:** S
**Priority:** P3
**Depends on:** WP0.5.

### Guard the local `/__dev/*` routes against browser requests

**What:** Before the dev hooks do real work, refuse `/__dev/*` requests whose `Host` is not `127.0.0.1:<port>`/`localhost:<port>` or whose `Origin` is set and is not the local web origin (or require `content-type: application/json` on both routes so a cross-origin request needs a preflight). Cover it in `apps/api/test/runtime.spec.ts`.

**Why:** `POST /__dev/deliver` is public and bodyless; binding to 127.0.0.1 stops other machines but not a web page open in the developer's browser (a simple cross-origin POST, or DNS rebinding), which could trigger delivery of due notifications on the local stack.

**Context:** Security finding in the WP0.4 `/ship` review. No impact while the hooks are no-ops; the Lambda root never mounts these routes.

**Effort:** S
**Priority:** P3
**Depends on:** WP0.6 (the hooks start delivering).

### One local stack per worktree

**What:** Let each git worktree run its own stack: a per-worktree `COMPOSE_PROJECT_NAME` and host ports (the code already honours `DYNAMODB_ENDPOINT`), documented in the README; or document that all worktrees share one stack and that `pnpm local:down` stops it for all of them.

**Why:** `tools/local/docker-compose.yml` has a fixed project name (`fisio-local`) and fixed ports, so parallel worktrees (implementation plan §7) share one in-memory DynamoDB Local. `pnpm local:down` in one worktree, or `local:up` with a changed compose file (which recreates the container), wipes the tables while another worktree's `pnpm test` runs, and that run fails part-way.

**Context:** Red-team finding from the WP0.3 `/ship` review, deferred by the owner.

**Effort:** S
**Priority:** P3
**Depends on:** The first parallel worktree lane (implementation plan §7).

### A Vitest project for tools/local

**What:** Give `tools/local` its own `vitest.config.ts` (listed in the root `vitest.config.ts`, with the testkit global setup) and move `packages/testkit/test/ensure-table.spec.ts` there, so the specs for `ensureTable` and `create-table` live next to the code and reach the CLI by its own path, not `../../../tools/local/...`.

**Why:** WP0.3 put the specs in testkit because `tools/local` had no Vitest project. A change in `tools/local` is caught only by a spec in another package, and the relative path breaks silently if either package moves.

**Context:** Maintainability finding from the WP0.3 `/ship` review, deferred by the owner. Natural moment: WP0.5, when `tools/local` gets the auth emulator and its specs.

**Effort:** S
**Priority:** P3
**Depends on:** WP0.5.

### CI and local:up speed

**What:** Start the containers right after checkout in CI (`docker compose ... up -d`) and wait for health only before `pnpm test`; use healthcheck `start_period` + `start_interval` (Docker Engine 25+) with a longer steady `interval`; run the independent `create-table` CLI specs concurrently with async `execFile` instead of serial `spawnSync`.

**Why:** Image pull and the DynamoDB Local JVM boot are added straight onto CI time after install, lint and typecheck; the 2 s healthcheck interval adds up to 2 s to every `local:up`; the four CLI spawns block a Vitest worker in turn.

**Context:** Performance findings from the WP0.3 `/ship` review, deferred by the owner. Measure before and after; the suite currently runs in about 4 s locally.

**Effort:** S
**Priority:** P4
**Depends on:** None.

### Local stack hardening from the WP0.3 final review

**What:** Small fixes to `tools/local` and the testkit setup, each with a spec where one is possible:
- In `ensureTable`, compare `error.name` (`ResourceNotFoundException`, `ResourceInUseException`) instead of `instanceof`: the caller's client may come from another copy of `@aws-sdk/client-dynamodb` if the two packages ever drift apart.
- Check the Node version at the top of `create-table.ts` (type stripping needs >= 22.18; `engines` stays `>=22.12` for the Lambda runtime) and print a clear message instead of an extension error.
- Add `BillingModeSummary.BillingMode` and `LocalSecondaryIndexes` to the schema fingerprint, and run the check when a create lost the race (`ResourceInUseException`), so a table another process made from a different definition is refused too.
- Global setup: keep the original error as `cause`, use `error.name` for SDK service errors, and add the "is the stack running?" hint only for connection errors and timeouts.
- TTL in `DISABLING` state: refuse with a named remedy instead of the raw AWS error.
- The mismatch message says "delete that table" with no command for it: add `node tools/local/src/delete-table.ts <stage>` or drop that option (and the same words in architecture §11.4).
- Items written under fresh tenants accumulate in a long-running container (`-inMemory`, no `ttl` on spec items): set `ttl` on spec items or document `local:down && local:up` as the reset.
- The DynamoDB healthcheck relies on `curl` being in the image; a digest bump to a slimmer base would fail `--wait` after about 60 s with no hint.
- `isTestkitSetup` in `tools/scripts/test/vitest-projects.spec.ts` should use `path.resolve` so an absolute `globalSetup` entry is accepted; `DEFAULT_LOCAL_ENDPOINT` no longer needs to be exported.

**Why:** None changes behaviour that matters today; each removes a confusing failure or a silent gap that later work packages (WP0.4–WP0.6, more spec files, longer-lived containers) would hit.

**Context:** Final review pass and adversarial pass of the WP0.3 `/ship` run, deferred by the owner (fixing them would have needed a third fix cycle). The adversarial pass also claimed that DynamoDB Local's CORS defaults to `*`; a live probe of `amazon/dynamodb-local:3.3.1` disproved it: no `Access-Control-Allow-Origin` is sent to any origin, so do not add `-cors` (an allow-list would open access).

**Effort:** S
**Priority:** P3
**Depends on:** None; natural moment: WP0.4 or WP0.5, when more specs use the testkit.

## Completed

- **Fence notifier writes on the delivery attempt** (WP0.6): every notifier transition is a conditional update on `status` and `updatedAt`; spec for the late result after a sweep.
- **Code delivery must not time the answer** (WP0.6): `startEmailOtp` reads the lockout for every email and fires the code email without awaiting it; spec in the emulator's sign-in specs.
- **Slot ids in URL paths** (WP0.4): `SlotId.toPathSegment`; route params decode through Hono and `SlotIdSchema`; round-trip spec through the in-process fetch adapter. The CloudFront check and the SPA client remain ("Slot ids through CloudFront and the SPA client").
- **OpenAPI patterns for refine-only schemas** (WP0.4): `SlotIdSchema`, `IsoDateSchema` and `LocalTimeSchema` carry the domain's shape as `regex` plus an example; the OpenAPI spec asserts the patterns; `conflict_retry_exhausted` no longer names the attempt count.
- **Map domain time errors to `validation_failed`** (WP0.4): the API error mapper recognises the domain errors by name (`isErrorNamed`, shared with `classifyError`); the time helpers throw `InvalidLocalValueError` for malformed input; `SlotIdSchema`'s refinement never throws, and the API refuses to start without Europe/Rome tz data. The request-path part remains ("Domain time errors with their request path").
- **Local stack hardening, two items** (WP0.4): the DynamoDB Local endpoint defaults to `127.0.0.1`; `testDocumentClient()` is cached per spec file and closed with `closeTestDocumentClient()`.
