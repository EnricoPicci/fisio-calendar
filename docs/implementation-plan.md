# Fisio Calendar — Implementation Plan

| | |
|---|---|
| Status | v1 — ready to execute |
| Date | 2026-10-24 |
| Inputs | `docs/architecture.md` v1.3 (reviewed), the 18 review tasks (T1–T18), `TODOS.md`, `prompts/idea.md` |
| Unit of work | **Work package (WP)** — one Claude Code session, one branch, one PR; done when its spec rows and journeys are green locally |

---

## 1. How to execute this plan

1. **One WP per session.** Start the session with: *"Implement WP1.3 from docs/implementation-plan.md; architecture sections §5.3, §6.2, §7.1 apply."* The WP lists exactly which architecture sections, spec rows (§10.4 catalogue) and journeys (§10.4 group H) it owns.
2. **Specs first, in the WP's own words.** Create the spec files with the catalogue titles as `describe`/`it` before writing production code; the titles are the documentation, the implementation makes them pass.
3. **Done = green locally.** A WP is finished when `pnpm test` is green on a laptop (the complete local suite: domain, API, view-model, headless journeys, template binding, infra assertions, bundle smoke, Playwright binding). Nothing is deployed to finish a WP.
4. **Cloud only through the gate.** `pnpm deploy:dev` (runs `pnpm test` first) at the end of each milestone, or whenever a cloud-only behaviour needs checking. `prod` only through the pipeline with manual approval (M3).
5. **Routine per WP:** branch `wp/<id>-<slug>` → specs → code → `pnpm test` → `/review` → `/ship` → PR → CI green → merge. `/code-review` or `/simplify` when a WP touched many files.
6. **Order within a milestone is a dependency order**, not a calendar. WPs marked ∥ can run in parallel worktrees (§7).
7. **Never widen a WP.** Something discovered outside the WP's scope goes to `TODOS.md` or a new WP line in this plan, in the same PR.

Effort is given as **CC sessions** (one focused Claude Code session ≈ 1–3 hours of wall-clock including review): S = 1 session, M = 2, L = 3–4.

---

## 2. Prerequisites (outside the code)

| # | Item | Needed by | Owner |
|---|---|---|---|
| P1 | Node 24 LTS (`.nvmrc`), pnpm 12 (`corepack enable`; the version is pinned in `package.json`), Docker Desktop, Git, GitHub CLI (`gh`, for `/ship`), an authenticator app (TOTP) on the developer's phone | WP0.1 | developer |
| P2 | GitHub repository with Actions enabled; branch protection on `main` (require the `test` job) | WP0.1 | developer |
| P3 | AWS account on the **Paid plan** (always-free allowances apply; the Free plan auto-closes after 6 months), region `eu-central-1`, IAM Identity Center or an admin user with MFA for the CDK bootstrap | WP0.10 | developer |
| P4 | Domain name; DNS delegated to Route 53 at WP0.10 (the hosted zone is created by the `Edge` stack) | WP0.10 | developer |
| P5 | Therapist's email address (bootstrap) and a sending identity (`no-reply@<domain>`); SES production-access request submitted at WP0.10 (takes ~1 day) | WP0.10 / M2 | developer |
| P6 | Decide the therapist's settings defaults for the seed: studio/pool durations and capacities, working hours for the first rules, reminder time (19:00), digest time (07:30) | WP1.1 | therapist + developer |

Nothing in M0 before WP0.10 depends on P3–P5: the whole skeleton is built and tested locally first.

---

## 3. Milestone M0 — Walking skeleton

**Goal.** The complete local stack, both sign-in flows, one page per role, the outbox → notifier → email path proven end to end with the invitation email, the full test harness including headless journeys, the three CDK stacks with offline assertions, CI — and only then the first `dev` deploy.
**Demo.** "I received an invitation, signed in with the code; the therapist signed in with TOTP" — on a laptop, then on `dev.<domain>` through the gated pipeline.
**Exit gate.** `pnpm test` green; `pnpm deploy:dev` green; `dev` smoke green; cloud contract tests green; the Cognito spike answered.

| WP | Scope | Architecture | Specs / journeys (done when green) | Effort | ∥ |
|---|---|---|---|---|---|
| **WP0.1 Repo and toolchain** | pnpm workspaces (`apps/web`, `apps/api`, `packages/domain`, `packages/contracts`, `packages/testkit`, `infra`, `tools/local`, `tools/bootstrap`, `e2e`); TypeScript strict configs; Biome; Vitest workspace config with quiet reporters; root scripts `test`, `test:cloud:*`, `typecheck`, `lint`, `local:up`, `dev`, `tick`, `seed`, `bootstrap:therapist`, `deploy:dev`, `smoke:dev`; `.gitignore`; `CLAUDE.md` (commands, conventions, rules from tooling doc §2.1); `.claude/settings.json` allowlist + the two hooks (typecheck on edit; block `cdk deploy`); GitHub Actions `test` job skeleton (runs `pnpm test` with Docker services); Dependabot | tooling doc §2, §7 | `pnpm test` runs and passes with empty suites; CI green on a PR; hook blocks `cdk deploy` | S | — |
| **WP0.2 Domain and contracts foundations** | `packages/domain`: `slot-id.ts` (branded `SlotId`, `format`/`parse`), `Clock` port + `FixedClock`, time helpers (`Europe/Rome`, date-fns v4 + tz), notification state machine (`pending/sending/sent/failed`, back-off table, error classification types). `packages/contracts`: `errors.ts` (ErrorCode catalogue + HTTP mapping), Zod base schemas (ids, E.164, ISO dates), `strings/it.ts` skeleton | §3.2 SlotId, §5.1, §5.2 catalogue, §5.4 state machine, §7.3 | D: SlotId round-trip and rejection; state machine: pending→sending→sent, retryable→pending with back-off, permanent→failed, attempts≥5→failed; DST helper on 2027-03-28 and 2027-10-31 | S | ∥ |
| **WP0.3 Local stack containers and table** | `tools/local/docker-compose.yml` (DynamoDB Local `-sharedDb`, Mailpit); single **table definition** module (`infra/lib/table-definition.ts`) consumed by CDK and by the local `create-table` script; `packages/testkit` DynamoDB helpers: create table once per run, `freshTenant()` for per-spec isolation, document client factory | §6.2, §6.4, §10.3, §11.4 | A: write/read item round-trip; two spec files with different tenants do not see each other's items | S | ∥ |
| **WP0.4 API skeleton** | Hono app; composition roots `runtime/lambda.ts` and `runtime/local.ts`; `Config` port (env / Lambda env); problem+json error handler emitting `urn:fisio:error:<code>`; `@hono/zod-openapi` wiring and `openapi.json` generation script; routes `GET /health`, `GET /me`; JWT middleware (`aws-jwt-verify` with configurable issuer/JWKS); **client-status middleware** (loads client item, refuses non-`enabled`); role guards; `/__dev/*` mounted only in `runtime/local.ts`; API spec harness in testkit (in-process `app.request`, fake JWT signer with the test JWKS, FakeChannel, in-process AsyncInvoker) | §4.4, §5.2, §8.2, §10.1–10.3 | A: health 200; `/me` for client and therapist; missing/invalid token → 401 `unauthenticated`; wrong role → 403; client in `invited`/`blocked` → 403 `forbidden` (T7 rows); problem+json carries a catalogued code; Zod rejection → 400 `validation_failed` with paths; generated authorisation-matrix spec harness (runs over all registered routes); `/__dev/tick` returns 404 in the Lambda runtime | M | after 0.2, 0.3 |
| **WP0.5 Identity: port, emulator, bootstrap** | `IdentityProvider` port (createUser, disableUser, enableUser, deleteUser, globalSignOut, setTotpPreference); `LocalIdentityProvider` + **auth emulator** (`tools/local/auth-emulator`: users in DynamoDB Local, email OTP through the email channel, wrong/expired/lockout rules, password + TOTP with `otplib`, RS256 JWTs with Cognito claims, JWKS endpoint, refresh with rotation); `CognitoIdentityProvider` implementation (AdminCreateUser `SUPPRESS`, AdminDisableUser, AdminUserGlobalSignOut, AdminSetUserMFAPreference) — unit-tested with the SDK mock, verified on `dev` in WP0.10; **`IdentityProvider.contract.spec.ts`** (shared); **bootstrap CLI** (`tools/bootstrap`: idempotent create therapist + TOTP preference + Settings item + one-time setup link; `--stage local` seeds the emulator); `tools/local/seed` (therapist via bootstrap, clients, no rules yet) | §8.1, §11.4, §11.5 | A/C: contract spec green against the emulator; bootstrap re-run is idempotent and keeps the TOTP preference; C1 rows: wrong code refused, expired code refused with message, five wrong codes → temporary lockout, unknown/blocked email → identical response | L | after 0.3 |
| **WP0.6 Outbox and notifier (invitation only)** | Notification repository with **deterministic keys** (`INVITE#<clientId>#<attempt>`, keys for REM/CONF/CANC/DIGEST/FAIL defined now, used later); `NotificationChannel` port + `FakeChannel` + `SmtpEmailChannel` (nodemailer → Mailpit) + `SesEmailChannel` (SDK v3; unit-tested with mock, contract on `dev`); `NotificationChannel.contract.spec.ts` (shared); `notifier` handler: deliver-by-ids, deliver-due, sweep, error classification, state machine application, SES-feedback entry point stub; `AsyncInvoker` port (in-process + `Lambda.invoke(Event)`); `jobs` handler with the tick dispatcher (deliver-due + sweep only for now; markers helper); invitation template (Italian, HTML + text); use case `AddClient` minimal: create client item + identity user + INVITE notification in one transaction, then async invoke; `POST /admin/clients` | §5.4, §3.5, §6.2 | A: S3 rows — pending→sending→sent on provider success; retryable error → pending with nextAttemptAt per back-off; permanent error → failed; attempts≥5 → failed; sweep counts `sending` older than 10 min as a failed attempt; deliver-due picks only due items; async invoke after commit delivers immediately; duplicate async invocations deliver once; INVITE key idempotent; `POST /admin/clients` → identity user created + invitation email in FakeChannel; duplicate email → 409 `client_exists` | L | after 0.4, 0.5 |
| **WP0.7 Web skeleton** | Vite + React 19 app; `ViewModel` base (`dispose()`, `stream()` tagging); `useObservable`; DI context; **`ApiClient` port returning Observables** (openapi-typescript types from `openapi.json`, `openapi-fetch` wrapped with `from()`, injectable `fetch`, bearer token, **`x-amz-content-sha256` on bodies**); `AuthService` port with `AmplifyAuthService` (USER_AUTH / EMAIL_OTP; password + TOTP) and `LocalAuthService` (emulator), selected at build time; `Strings` (it); `Storage` port; pages: sign-in (client code flow, therapist password + TOTP), client home (empty bookings + calendar placeholder), therapist home; `SignInViewModel`, `SessionViewModel` (refresh, signedOut$); Biome rule: no `rxjs`/`useState`/`useEffect` imports under `src/pages` | §7 | V (marble): SignIn busy$/error$ sequences for wrong code, lockout, success; Session: silent refresh when expired, signedOut$ when refresh refused; template binding tests for the sign-in page | M | after 0.4 |
| **WP0.8 Testkit journeys and surface coverage** | `JourneyHarness` (actors: `j.client(email).signIn()`, `j.therapist().signIn()`; `open(VM)`; `j.record`, `j.recorded`, `j.trace`, `j.emails`, `j.clock`, `j.tick()`, `j.assert` operator, `journey`/`journey$`); `ObservableRecorder`, `TraceRecorder` (methods, subscribe/unsubscribe, emissions, API calls, emails, clock); journey report renderer → `docs/journeys.md`; **surface-coverage check** (fails `pnpm test` on an unexercised view-model member); journeys **J1** (invitation → code → first calendar view, placeholder week), **J2** (sign-in misuse), **J8-a** (therapist password → TOTP → home); Playwright setup with the sign-in **binding journey** against `pnpm dev` | §10.5 | J1, J2, J8-a green; `docs/journeys.md` rendered; surface check passes with an empty allowlist; Playwright binding journey green | M | after 0.6, 0.7 |
| **WP0.9 Infrastructure as code** | CDK app, three stacks per stage: `Stateful` (table from the shared definition, PITR, TTL, deletion protection in prod; Cognito pool Essentials, MFA optional, `ALLOW_USER_AUTH`, EMAIL_OTP, managed login domain, groups, app client with refresh rotation, SES email sending; SES identity + configuration set + feedback SNS topic), `App` (api Lambda + Function URL `AWS_IAM` + reserved concurrency 10; jobs + Scheduler rate 15 min; notifier + SNS subscription; auth-triggers attached to the pool; per-function roles; alarms: errors, failed notifications, reminder marker; Budgets €5/€10), `Edge` (us-east-1: ACM cert, WAF web ACL with core, known-bad-inputs and rate rules, private S3 + BucketDeployment, CloudFront with OAC for S3 and for the Function URL, managed CachingDisabled/AllViewerExceptHostHeader on `/api/*`, viewer-request SPA rewrite Function, viewer-response CSP Function, **no CustomErrorResponses**, Route 53 zone + records, `CfnSubscription` FREE with distribution/ACL/zone ARNs); `crossRegionReferences`; esbuild bundling; **infra assertions** (group G) and **bundle smoke** (loads each bundle, sample event; `/__dev/*` → 404) | §9.1, §9.3, §11.1 | I: all group G rows; S (local): bundle smoke rows; `cdk synth` runs offline inside `pnpm test` | L | ∥ (from 0.1) |
| **WP0.10 First cloud deploy and spikes** | Prerequisites P3–P5; `cdk bootstrap`; GitHub OIDC role; CI `deploy-dev` job (`needs: test`) + `smoke-dev`; `pnpm deploy:dev` script; smoke script (health, deep link, `/api/v1/nope` 404 JSON, direct Function URL 403, POST with body through CloudFront, OTP round-trip, one email to a verified address); **cloud contract tests** `pnpm test:cloud:auth` / `test:cloud:email`; **Cognito spike**: `AdminCreateUser` without password + `EMAIL_OTP` sign-in (fallback: random unusable password); run `bootstrap:therapist --stage dev`; submit SES production access request; verify the CloudFront plan subscription is `ACTIVE` | §11.2–11.5, §15 | S: dev smoke green; C: both contract specs green on dev; spike result recorded in §15 of the architecture | M | after 0.8, 0.9 |

**Traceability (review tasks):** T1 → WP0.5/WP0.9 · T2 → WP0.4 · T4 → WP0.6 · T8 → WP0.7/WP0.9/WP0.10 · T11 → WP0.6 · T13 → WP0.5 · T14 → WP0.2 · T16 (harness part) → WP0.4/WP0.8 · T17 → WP0.9 · T7 → WP0.9/WP0.10.

---

## 4. Milestone M1 — Calendar

**Goal.** Settings, availability rules with the no-overlap invariant, slot generation and horizon, client booking with every policy, therapist calendar, clients management, book on behalf, audit.
**Demo.** "A client booked a pool slot; the therapist sees it; a second client was refused the last place" — and `docs/journeys.md` reads as the user manual.
**Exit gate.** `pnpm test` green; `pnpm deploy:dev` green; the therapist tries a week on `dev` with two or three real test clients.

| WP | Scope | Architecture | Specs / journeys | Effort | ∥ |
|---|---|---|---|---|---|
| **WP1.1 Settings** | Settings repository and defaults; `GET/PUT /admin/settings` with Zod; `SettingsViewModel` + page; seed uses P6 values | §3.2, §5.2, T2 | A: T2 rows; V: marble for save busy$/error$; surface coverage | S | ∥ |
| **WP1.2 Rules and slot generation** | Domain: rule validation with **overlap invariant across types** and validity ranges; slot generation for horizon + 7 (skips and reports slots overlapping existing/booked slots, marks orphaned, bumps `generation`); conditional regeneration (`bookedCount = 0` delete); jobs **extend-horizon** (03:00 marker); `GET/POST/PUT/DELETE /admin/rules` (response lists orphaned/skipped); `RulesViewModel` + page | §3.2, §5.3, §6.2 | D: T3/S1 domain rows (overlap refused, disjoint validity allowed, validTo past, idempotent, DST, no overlap with orphaned); A: T3 API rows, horizon extension idempotent; J8 complete, **J9** | L | after 1.1 |
| **WP1.3 Client calendar and booking** | `GET /slots` (month partition query, `FilterExpression entity = SLOT`, projection with `placesLeft`, `generation`); `POST /me/bookings` transaction with conditions (`attribute_exists`, `status`, `bookedCount`, `generation`), CONF notification key, audit; **TransactionConflict retry** + reason-index mapping; `FaultInjectingDynamo` in testkit; `DELETE /me/bookings/{id}` with cutoff; `GET /me/bookings` (GSI1); `ClientCalendarViewModel`, `MyBookingsViewModel` + pages (week navigation, places left, book/free, busy/error/empty states, slot_changed reload) | §5.3, §6.3, §7 | A: C2, C3, C4 rows (incl. parallel last place, injected conflict, slot_changed, no phantom, regeneration never deletes booked); D: cutoff boundaries; V (marble): busy$/week$/error$ for book, free, slot_changed, double click, empty state; **J3, J4, J5, J6**; Playwright binding: calendar renders `week$` and a click calls `book()` | L | after 1.2 |
| **WP1.4 Therapist calendar, book on behalf** | `GET /admin/slots` (slots + bookings + names); `POST /admin/bookings`, `DELETE /admin/bookings/{id}` (no cutoff); `TherapistCalendarViewModel` (week/day, orphaned and cancelled styling) + page | §3.3 T4, T8 | A: T4, T8 rows; V marbles; **J16** | M | after 1.3 |
| **WP1.5 Clients management** | `GET/PATCH /admin/clients/{id}` (edit, block/unblock → identity disable/enable + global sign-out), `POST /admin/clients/{id}/invite` (INVITE attempt+1), never-signed-in computation (`invitedAt`, `lastSignInAt` updated by the API on first authenticated call), `ClientsViewModel` + pages (list, add, edit, block, invite, badges) | §3.2, §3.3 T7, §8.1 | A: T7 rows except erase/bounce (block → disabled + sign-out; still-valid token → 403; never-signed-in after 7 days); V marbles; **J7**, **J14-a** (add, block) | M | after 1.3 |
| **WP1.6 Audit** | Audit repository (field names only, actor, target, reason); applied to every mutation use case; `GET /admin/audit?from` (optional, therapist) | §6.2, §9.4 | A: S4 row; no value of name/email/phone appears in any audit item | S | after 1.5 |
| **WP1.7 Dashboard v1** | `GET /admin/dashboard` (today, tomorrow, orphaned slots); `DashboardViewModel` + page (failed/bounced/never-signed-in sections wired in M2) | §3.3 T10 | A: dashboard rows for today/tomorrow/orphaned; V marble; surface coverage | S | after 1.4, 1.5 |

**Traceability:** T5 → WP1.3 · T6 → WP1.2 · T10 → WP1.2/WP1.3 · T15 (audit part) → WP1.6 · T16 (projection spec) → WP1.3 · T18 (filter) → WP1.3.

---

## 5. Milestone M2 — Notifications

**Goal.** Every notification of §3.4 live: confirmations, cancellations (slot and day), reminders with catch-up, therapist action emails and digest, SES feedback, notification log, alarms. **Production launch candidate.**
**Demo.** "Reminders arrived at 19:00; a cancelled day emailed everyone once; a bounced address showed up on the dashboard."
**Exit gate.** `pnpm test` green; `dev` runs for a week with the therapist and test clients; SES production access granted; alarms verified by forcing one failure on `dev`.

| WP | Scope | Architecture | Specs / journeys | Effort | ∥ |
|---|---|---|---|---|---|
| **WP2.1 Confirmation and therapist immediate emails** | Templates confirmation + therapist "booking freed"; CONF key written in the booking transaction (already), delivered; therapist email on client free | §3.4, §3.5 | A: C3 confirmation delivered; C4 therapist notified; **J3 trace shows the email**; template rendering specs (Italian dates) | S | ∥ |
| **WP2.2 Cancel slot and cancel day** | `POST /admin/slots/{id}/cancel` and `/reopen` (idempotent); **cancel day**: per-slot conditional transactions, per-slot outcome list, CANC keys, audit; `CancelDayViewModel` (outcomes$, retryRemaining) + dialog; `FaultInjectingDynamo` k-th failure mode | §5.3, §3.3 T5/T6 | A: T5 rows (incl. no-op second cancel, reopen); T6 rows (outcomes, injected failure at k → retry completes, zero duplicates); **J10**; Playwright binding: cancel-day dialog renders `outcomes$` | M | ∥ |
| **WP2.3 Reminders** | Jobs **create-reminders** with catch-up semantics and marker; REM keys; template; alarm metric for missing marker | §5.3 | A: S2 rows (once per booking per day, late tick, crash between puts and marker, cancelled bookings excluded); **J11** | M | after 2.1 |
| **WP2.4 Daily digest** | Jobs **digest** at `digestTime` (marker, DIGEST key); content builder (new bookings since last digest, tomorrow, orphaned, failed, bounced, never-signed-in); template; settings field | §3.4, §3.3 T10 | A: T10 digest rows; **J12** | M | after 2.3 |
| **WP2.5 SES feedback and bounced clients** | SNS → notifier `ses-feedback` handler; `emailStatus` on client; FAIL notification to therapist; dashboard sections (failed, bounced, never-signed-in); local simulation of an SES-shaped event; `dev` check with the SES mailbox simulator | §5.4, §3.4 | A: T7 bounce rows; **J13**; dashboard rows complete | M | after 2.4 |
| **WP2.6 Notifications log and retry** | `GET /admin/notifications`, `POST /admin/notifications/{id}/retry` (failed → pending); `NotificationsViewModel` + page | §3.3 T9 | A: T9 rows; **J15** | S | after 2.2 |
| **WP2.7 Operations for launch candidate** | Alarms wired to an SNS email topic (errors, failed notifications > 0, reminder marker missing, api 5xx); CloudWatch log retention; SES domain DKIM/SPF/DMARC verified; `SesEmailChannel` contract test green on `dev`; forced-failure drill on `dev` (one alarm fires and is received); `docs/specs.md`, `docs/journeys.md`, `docs/api.html` published by CI | §9.3, §10.2, §11.3 | S/C: contract tests green; drill documented in the runbook | S | after 2.5 |

**Traceability:** T3 → WP2.3 · T9 → WP2.2 · T12 → WP2.1/WP2.4/WP2.5 · T11 (alarms) → WP2.7.

---

## 6. Milestone M3 — Hardening and launch

**Goal.** GDPR completeness, security review, load sanity, runbook, `prod` cutover.
**Demo.** Launched: the therapist's real clients use `https://<domain>`.
**Exit gate.** `/cso` findings resolved or accepted in writing; `prod` smoke green; bootstrap run on `prod`; TODOS reviewed.

| WP | Scope | Architecture | Specs / journeys | Effort | ∥ |
|---|---|---|---|---|---|
| **WP3.1 GDPR** | `DELETE /admin/clients/{id}` erasure (identity delete, client delete, bookings anonymised with counts intact, notifications deleted, audit re-targeted), `GET /admin/clients/{id}/export`; privacy notice page (processors, retention, 35-day PITR); consent fields shown read-only | §9.4 | A: T7 erase/export rows, "no item contains the client's email or phone"; **J14** complete | M | ∥ |
| **WP3.2 Security review** | `/cso` on the repository; dependency audit; CSP verified in the browser on `dev` (no violations in console); WAF rate rule tuned from `dev` logs; secrets scan; least-privilege check against the infra assertions | §9 | Findings fixed or accepted and recorded in `docs/security-review.md`; infra assertions extended for anything found | M | ∥ |
| **WP3.3 Load and cold-start sanity** | Small load run against `dev` (e.g. 50 concurrent calendar loads, 20 concurrent bookings on one slot) with autocannon/k6; confirm reserved concurrency behaviour (429s are clean problem+json), cold start < 1 s, no 5xx | §9.3, §12 | Results recorded in the runbook; one alarm threshold adjusted if needed | S | after 3.2 |
| **WP3.4 Runbook, prod cutover, hand-over** | `docs/runbook.md` (bootstrap, deploy, rollback via CDK, alarms and what to do, SES reputation, restoring from PITR, erasure request procedure); CI `deploy-prod` with manual approval; `prod` bootstrap of the therapist; first real rules and clients entered by the therapist; `prod` smoke; post-launch watch (alarms, first digest, first reminders); `TODOS.md` priorities revisited (separate accounts first) | §11.3, §11.5, `TODOS.md` | `prod` smoke green; first digest and first reminders observed; `/retro` run | M | after 3.1–3.3 |

**Traceability:** T15 (erasure) → WP3.1 · remaining T18 doc items → WP3.4.

---

## 7. Parallel lanes (worktrees)

| Lane | WPs | Shares modules with | Notes |
|---|---|---|---|
| A — Domain & contracts | 0.2 → 1.2 (domain part) | B (types) | Finishes first; defines `SlotId`, `ErrorCode`, state machine, `IdentityProvider` port signature |
| B — API | 0.4 → 0.6 → 1.3 → 1.4 → 1.5 → 1.6 → 2.x | A, C (`identity/`) | The long pole; keep WPs small |
| C — Local tools | 0.3, 0.5 (emulator, bootstrap, seed) | B (`apps/api/src/identity/`) | Define the port in A before starting C's emulator |
| D — Web | 0.7 → 1.1 → 1.3 (VMs/pages) → 1.4 → 1.5 → 1.7 → 2.2 → 2.6 | B (OpenAPI types) | Each web WP waits for its API WP's `openapi.json` |
| E — Infra | 0.9 → 0.10 → 2.7 → 3.2 | none until 0.10 | Independent from 0.1 onward |
| F — Testkit & journeys | 0.8, then journeys inside each feature WP | B, D | After 0.8 the harness is stable; journeys belong to the WP that delivers the flow |

Execution: **0.1 → {0.2, 0.3, 0.9} in parallel → {0.4, 0.5} → 0.6 and 0.7 in parallel → 0.8 → 0.10.** In M1: 1.1 ∥ 1.2 → 1.3 → {1.4, 1.5} → 1.6 → 1.7. In M2: {2.1, 2.2} → 2.3 → 2.4 → 2.5 → 2.6 → 2.7. In M3: {3.1, 3.2} → 3.3 → 3.4.
Conflict flags: WP0.5 and WP0.4 both touch `apps/api/src/identity/` and the middleware — land 0.4 first, or agree the port file in 0.2. WP1.3 and WP1.4 both touch the slots repository — sequential.

---

## 8. Definition of done (every WP)

- Spec files exist for every catalogue row the WP owns, with the catalogue titles; all green.
- Journeys the WP owns are green and appear in `docs/journeys.md`; the surface-coverage check passes (no allowlist entries added).
- `pnpm test` green locally (whole suite, not only the WP's packages); `pnpm typecheck` and `pnpm lint` clean.
- No `cdk deploy` was run to finish the WP; cloud checks happen at the milestone gate through `pnpm deploy:dev`.
- Architecture document updated if the WP changed a decision (append to §14, bump the version row); anything out of scope added to `TODOS.md`.
- PR reviewed with `/review`, shipped with `/ship`, CI green, merged to `main`.

---

## 9. Spikes and known risks on the critical path

| When | Spike / risk | Decision if it fails |
|---|---|---|
| WP0.7 | Amplify v6 `signIn` with `authFlowType: 'USER_AUTH'`, `preferredChallenge: 'EMAIL_OTP'`, `confirmSignIn`; TOTP setup (`setUpTOTP`, `verifyTOTPSetup`) | Fall back to the Cognito SDK (`InitiateAuth`/`RespondToAuthChallenge`) behind the same `AuthService` port |
| WP0.9 | `aws-cdk-lib/aws-scheduler` L2 availability; `CfnSubscription` property names; OAC for Lambda Function URL in the CloudFront L2 (`FunctionUrlOrigin.withOriginAccessControl`) | Use L1 (`Cfn*`) properties; the assertions keep the contract |
| WP0.10 | Passwordless `EMAIL_OTP` for a user created by `AdminCreateUser` without a password | Set a random unusable password at creation; keep clients on `EMAIL_OTP` |
| WP0.10 | `x-amz-content-sha256` requirement on bodies through CloudFront → Function URL | Already in the fetch wrapper; smoke posts a body; if OAC rejects a header shape, follow the AWS doc for the exact header set |
| WP0.10 | Cross-region reference `Edge` → `App` for the Function URL domain | Pass the domain via SSM parameter + `fromLookup`-free read, or deploy `Edge` with a context value |
| WP2.7 | SES production access timing | Request at WP0.10; until granted, `dev` sends only to verified addresses |

---

## 10. What this plan deliberately leaves out

WhatsApp channel, PWA, English UI and separate AWS accounts are in `TODOS.md` with context and priorities. Recurring bookings, waiting list, SMS fallback and ICS export are backlog candidates not yet written up. None of them is on the path to launch.
