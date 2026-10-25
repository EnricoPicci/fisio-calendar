# TODOS

## Notifications

### WhatsApp channel option

**What:** A `WhatsAppChannel` adapter (Meta Cloud API, or Twilio as fallback) behind the existing `NotificationChannel` interface, Italian Utility templates approved by Meta, per-client opt-in with recorded consent, a WhatsApp message counter on the therapist dashboard, and an authenticated entry point for delivery-status webhooks.

**Why:** The original brief wanted WhatsApp reminders and cancellations; v1 ships email only. The architecture keeps the seam (`channels` and `consentAt` on the client, one outbox item per channel, the delivery state machine) so this is additive.

**Context:** `docs/architecture.md` §12.1 holds the verified cost facts (Italy Utility rate €0.0248 per delivered message as of the July 2026 rate card; ≈ €11/month if enabled for all ~200 clients, ≈ €3.5 at 30 % opt-in) and the prerequisites with lead time: Meta Business account and business verification, a phone number dedicated to the API (not the therapist's personal number), display-name and template approval, a payment method. Meta becomes a GDPR processor with non-EU transfers, hence opt-in per client. Start with the Meta account and number; the code is the small part. Webhooks need their own authenticated entry point because the API sits behind CloudFront OAC (§9.2).

**Effort:** M
**Priority:** P3
**Depends on:** v1 launched; the therapist's decision on who pays per message and whether reminders or only cancellations go through WhatsApp.

### Fence notifier writes on the delivery attempt

**What:** Make the notifier's conditional writes for `markSent`, `markFailedAttempt` and `sweepStale` check a per-attempt token (`updatedAt` from `startDelivery`, or a new `attemptToken` in `DeliveryState`), not only `status = sending`. Add a spec for the late-completion race.

**Why:** The domain transitions in `packages/domain/src/notification-state.ts` check status only. A slow notifier whose item was swept and re-sent sees `sending` again, so its late result can overwrite the second attempt: a duplicate email, a lost outcome or a phantom failed attempt.

**Context:** Found by the red team in the WP0.2 `/ship` review. The fix belongs where the conditional `UpdateItem` is written (notification repository, WP0.6). Fencing on `updatedAt` needs no domain change; a token field does.

**Effort:** S
**Priority:** P1
**Depends on:** WP0.6.

### Notifier edge cases from the WP0.2 review

**What:** Handle these cases when the notifier applies the delivery state machine:
- Do not raise `alertTherapist` for the therapist's own FAIL, alert or DIGEST notifications, so a broken SES account does not loop; rely on the failed-notifications alarm instead.
- Make template-render errors and SES rejections such as `MessageRejected` permanent (`PermanentError`), with one channel spec per SES error name; `classifyError` treats anything unknown as retryable.
- Parse stored `nextAttemptAt` and `updatedAt` through `IsoDateTimeSchema` at the repository boundary; a malformed value makes `isDue`/`isStale` false forever and the item sticks silently.
- When a transition drops an attribute (`lastError` in `markSent`; `providerMessageId` and `sentAt` in `markFailedAttempt` and `sweepStale`; `providerMessageId` when `markSent` gets no usable id), the repository must `REMOVE` every attribute absent from the returned state; an `UpdateItem SET` of the returned fields leaves the old value in DynamoDB. Cover it with an API spec on DynamoDB Local (a stale id on a sending item, a retryable failure, then no `providerMessageId` stored).
- Redact or classify provider error text before it reaches `markFailedAttempt` (the domain only caps it at 500 characters): SES and SDK messages can carry recipient addresses, request ids or ARNs, and `lastError` is stored and shown on the dashboard. Log the full message instead.
- A manual retry (T9) of a failure older than about a month leaves the item in its creation-month partition, which deliver-due no longer queries (§6.3), so it never sends and never alerts. Re-home the item to the current month in the retry use case, or refuse the retry with an error code.
- `sweepStale` throws `InvalidTransitionError` for an item that is not stale by its own clock reading (the DynamoDB filter `updatedAt < :stale` and the domain's `now` can disagree at the boundary). Catch it per item in the jobs handler so one item cannot abort the sweep, and keep the notifier Lambda timeout plus SES SDK retries well under `SENDING_STALE_AFTER_MINUTES` (an infra assertion), or the sweep re-queues a send that is still running and the email goes out twice.
- Channel adapters pass `markSent` a provider id that is a string or `undefined`, never invented and never another type: `markSent` runs after the provider accepted, and a non-string would make its `.trim()` throw, leaving the item in `sending` for the sweep to send again. Add a `typeof` guard in `markSent` (and store the trimmed id) when the adapter lands, with a spec that passes a non-string id.
- A confirmation or reminder still in back-off can go out after the booking or slot was cancelled. Give items an expiry or a superseded check so `startDelivery` callers skip obsolete messages; cover it with a journey (cancel while CONF is in back-off: exactly one CANC, no later CONF).

**Why:** Each one is correct in the pure domain but fails at the integration boundary, where nothing in WP0.2 can test it.

**Context:** Red-team findings from the WP0.2 `/ship` review, deferred because they belong to the notifier and repository code (CLAUDE.md: never widen a work package). Cover each with an API spec on DynamoDB Local.

**Effort:** M
**Priority:** P2
**Depends on:** WP0.6.

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

## Auth

### Email case and id format across Cognito and the auth emulator

**What:** Make sure every path that stores or compares an email uses `EmailSchema` (trimmed, lower-cased): sign-up, the therapist's client invite, Cognito `username`/`email` attributes, and the emulator. Check that the emulator issues `sub` values that `ClientIdSchema` (`z.uuid()`) accepts, the same version Cognito uses.

**Why:** Cognito treats email aliases case-insensitively only when the pool is configured so; if one path lower-cases and another does not, one person can end up with two clients, or fail to sign in. An emulator `sub` that is not a valid UUID would make local specs pass on ids production never sees, or fail on ids it does.

**Context:** WP0.2 follow-up 16 (adversarial review). `EmailSchema` and `ClientIdSchema` are in `packages/contracts/src/schemas.ts`.

**Effort:** S
**Priority:** P2
**Depends on:** The Cognito and auth-emulator work packages.

### Bearer tokens through CloudFront OAC to the Function URL

**What:** Decide how the SPA's access token reaches the `api` Lambda behind CloudFront, then make `authorize` (`apps/api/src/http/access.ts`), the SPA `ApiClient` and the CDK `App` stack agree. Options: (a) a custom header such as `x-fisio-authorization: Bearer …`, forwarded by the origin request policy, with the API reading it in the cloud; (b) a Lambda Web Function origin with OAC signing behaviour `always-amz-auth`, which keeps the viewer's `Authorization`; (c) another design. Add a `dev` smoke step that calls `GET /api/v1/me` through CloudFront with a real token.

**Why:** OAC signing behaviour `always` overwrites the viewer's `Authorization` header with CloudFront's SigV4 signature. `no-override` passes it unsigned, so the `AWS_IAM` Function URL refuses it, and `always-amz-auth` is valid only for Lambda Web Function origins (AWS docs: "Restrict access to an AWS Lambda function URL origin", `OriginAccessControlConfig.signingBehavior`). As designed (§8.2 bearer in `Authorization`, §9.1 OAC + IAM Function URL), every member and therapist route would answer 401 in `dev`/`prod`, while every local spec passes. It fails closed.

**Context:** Red-team finding in the WP0.4 `/ship` review, verified against the AWS docs. The decision touches `infra/` and the SPA, so it was deferred (CLAUDE.md: ask before changing `infra/`; never widen a WP). Architecture §9.1 carries an open-decision note.

**Effort:** S (code) once decided
**Priority:** P1
**Depends on:** Must be settled before WP0.9 (CDK `App` stack) and WP0.7 (SPA `ApiClient`).

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

**Why:** The packages export raw `.ts` with extensionless relative imports (`./time`), and they use TypeScript constructor parameter properties (`readonly date` in `NonexistentLocalTimeError`, `InvalidTimeZoneError`, `InvalidSlotIdError`). Node's type stripping rejects both: extensionless specifiers do not resolve, and parameter properties fail with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, so a loader that only adds extensions is not enough (consider `erasableSyntaxOnly`).

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

## Local stack and test harness

### Dependency direction between testkit and tools/local

**What:** Move the DynamoDB Local helpers (`localDynamoClient`, `ensureTable`, `createTableInput`, `TableDefinitionMismatchError`) out of `tools/local` into a package under `packages/` (or into `@fisio/testkit`), and make `tools/local`'s `create-table` depend on it, not the reverse. Record in `packages/README.md` which way `tools/*` and `packages/*` may depend on each other.

**Why:** WP0.3 made `@fisio/testkit` (a package) depend on `@fisio/local` (a tool). From WP0.5, `tools/local` gets the auth emulator, tick runner and seed, which run `apps/api` code, while `apps/api` takes `@fisio/testkit` as a dev dependency for its spec harness: `apps/api → testkit → tools/local → apps/api` is a workspace cycle.

**Context:** Maintainability finding from the WP0.3 `/ship` review, deferred by the owner (CLAUDE.md: never widen a work package).

**Effort:** S
**Priority:** P2
**Depends on:** WP0.5 (before `tools/local` imports `apps/api`).

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

- **Slot ids in URL paths** (WP0.4): `SlotId.toPathSegment`; route params decode through Hono and `SlotIdSchema`; round-trip spec through the in-process fetch adapter. The CloudFront check and the SPA client remain ("Slot ids through CloudFront and the SPA client").
- **OpenAPI patterns for refine-only schemas** (WP0.4): `SlotIdSchema`, `IsoDateSchema` and `LocalTimeSchema` carry the domain's shape as `regex` plus an example; the OpenAPI spec asserts the patterns; `conflict_retry_exhausted` no longer names the attempt count.
- **Map domain time errors to `validation_failed`** (WP0.4): the API error mapper recognises the domain errors by name (`isErrorNamed`, shared with `classifyError`); the time helpers throw `InvalidLocalValueError` for malformed input; `SlotIdSchema`'s refinement never throws, and the API refuses to start without Europe/Rome tz data. The request-path part remains ("Domain time errors with their request path").
- **Local stack hardening, two items** (WP0.4): the DynamoDB Local endpoint defaults to `127.0.0.1`; `testDocumentClient()` is cached per spec file and closed with `closeTestDocumentClient()`.
