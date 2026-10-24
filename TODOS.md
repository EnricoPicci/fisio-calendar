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

**What:** Handle four cases when the notifier applies the delivery state machine:
- Do not raise `alertTherapist` for the therapist's own FAIL, alert or DIGEST notifications, so a broken SES account does not loop; rely on the failed-notifications alarm instead.
- Make template-render errors and SES rejections such as `MessageRejected` permanent (`PermanentError`), with one channel spec per SES error name; `classifyError` treats anything unknown as retryable.
- Parse stored `nextAttemptAt` and `updatedAt` through `IsoDateTimeSchema` at the repository boundary; a malformed value makes `isDue`/`isStale` false forever and the item sticks silently.
- When a transition drops `lastError` (`markSent`), the repository must `REMOVE` the attribute; an `UpdateItem SET` of the returned fields leaves the old error on a sent item.
- Redact or classify provider error text before it reaches `markFailedAttempt` (the domain only caps it at 500 characters): SES and SDK messages can carry recipient addresses, request ids or ARNs, and `lastError` is stored and shown on the dashboard. Log the full message instead.
- A manual retry (T9) of a failure older than about a month leaves the item in its creation-month partition, which deliver-due no longer queries (§6.3), so it never sends and never alerts. Re-home the item to the current month in the retry use case, or refuse the retry with an error code.
- `sweepStale` throws `InvalidTransitionError` for an item that is not stale by its own clock reading (the DynamoDB filter `updatedAt < :stale` and the domain's `now` can disagree at the boundary). Catch it per item in the jobs handler so one item cannot abort the sweep, and keep the notifier Lambda timeout plus SES SDK retries well under `SENDING_STALE_AFTER_MINUTES` (an infra assertion), or the sweep re-queues a send that is still running and the email goes out twice.
- A confirmation or reminder still in back-off can go out after the booking or slot was cancelled. Give items an expiry or a superseded check so `startDelivery` callers skip obsolete messages; cover it with a journey (cancel while CONF is in back-off: exactly one CANC, no later CONF).

**Why:** Each one is correct in the pure domain but fails at the integration boundary, where nothing in WP0.2 can test it.

**Context:** Red-team findings from the WP0.2 `/ship` review, deferred because they belong to the notifier and repository code (CLAUDE.md: never widen a work package). Cover each with an API spec on DynamoDB Local.

**Effort:** M
**Priority:** P2
**Depends on:** WP0.6.

## API

### Slot ids in URL paths

**What:** Give `SlotId` a URL-safe path form (for example `SlotId.toPathSegment` / `fromPathSegment` with `encodeURIComponent`) and require the SPA API client and the route param schemas to use it; add a spec that round-trips `/admin/slots/{slotId}/cancel` through the in-process fetch adapter.

**Why:** A slot id contains `#` and `:`. Unencoded in `POST /admin/slots/{slotId}/cancel`, the `#` starts a URL fragment, so the request silently hits `/admin/slots/2027-03-28T09:00` and returns 404 or the wrong route.

**Context:** Red-team finding in the WP0.2 `/ship` review. Decide in WP0.4 (route params) at the latest, before WP1.4 adds the slot cancel and reopen routes. Check that `%23` survives CloudFront and the Function URL.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.4.

### OpenAPI patterns for refine-only schemas

**What:** Give `SlotIdSchema`, `IsoDateSchema` and `LocalTimeSchema` in `packages/contracts/src/schemas.ts` a `.regex()` and an example next to their `refine`, use a brand instead of `transform` for `SlotIdSchema` if response schemas need it, and assert in the OpenAPI generation spec that these fields carry a pattern. Word the `conflict_retry_exhausted` meaning so it cannot drift from the API's retry constant ("after 3 attempts" today).

**Why:** `@hono/zod-openapi` cannot describe a `refine` or a `transform`, so `docs/openapi.json` would show plain strings and the typed SPA client would lose the formats.

**Context:** Red-team and maintainability findings in the WP0.2 `/ship` review; the schemas validate correctly today, only the generated contract is affected.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.4 (OpenAPI generation).

### Map domain time errors to `validation_failed`

**What:** In the API error mapper, turn `NonexistentLocalTimeError`, `InvalidTimeZoneError` and the `RangeError`s of the time helpers into `validation_failed` (400) with the offending path, and cover it with an endpoint spec (a rule that starts at 02:30 on 2027-03-28).

**Why:** `SlotIdSchema` now refuses a slot id inside the DST gap, but other inputs (rule start times, date ranges) reach `localDateTimeToUtc` as separate date and time fields. Unmapped, the throw becomes a 500.

Recognise the domain errors by name or a shared brand as well as `instanceof`: two copies of `@fisio/domain` in one bundle make `instanceof` fail and turn a 400 into a 500. `classifyError` already does this for `PermanentError`; use one helper for every exported error.

**Context:** WP0.2 follow-up 26. The slot-id half is fixed in `SlotIdSchema` and `SlotId.format`; the mapper does not exist before WP0.4.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.4.

### Bounds for date ranges and the booking horizon

**What:** Decide where range limits live: a maximum span for `from`/`to` query pairs (calendar views, the therapist's slot list), a booking horizon (how far ahead a client may book), and `from <= to`. Put the shared limits in `packages/contracts` next to `IsoDateSchema`, and the business ones (horizon) in the domain.

**Why:** `IsoDateSchema` accepts any real date from 1900 to 9999, so a request for a 8,000-year range is valid today and would make the API generate or query millions of days.

**Context:** WP0.2 follow-up 14 (adversarial review). Nothing reads a range before WP0.4/WP1.x.

**Effort:** S
**Priority:** P2
**Depends on:** WP0.4.

## Auth

### Email case and id format across Cognito and the auth emulator

**What:** Make sure every path that stores or compares an email uses `EmailSchema` (trimmed, lower-cased): sign-up, the therapist's client invite, Cognito `username`/`email` attributes, and the emulator. Check that the emulator issues `sub` values that `ClientIdSchema` (`z.uuid()`) accepts, the same version Cognito uses.

**Why:** Cognito treats email aliases case-insensitively only when the pool is configured so; if one path lower-cases and another does not, one person can end up with two clients, or fail to sign in. An emulator `sub` that is not a valid UUID would make local specs pass on ids production never sees, or fail on ids it does.

**Context:** WP0.2 follow-up 16 (adversarial review). `EmailSchema` and `ClientIdSchema` are in `packages/contracts/src/schemas.ts`.

**Effort:** S
**Priority:** P2
**Depends on:** The Cognito and auth-emulator work packages.

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

**Why:** The packages export raw `.ts` with extensionless relative imports (`./time`). Node 22's type stripping does not resolve extensionless specifiers, so `node script.ts` importing `@fisio/domain` fails at load.

**Context:** WP0.2 follow-up 15 (adversarial review). Bundled Lambdas are unaffected; scripts run directly are not.

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

## Completed
