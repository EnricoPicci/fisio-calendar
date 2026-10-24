# Fisio Calendar — Tools and Skills for Building It with Claude Code

| | |
|---|---|
| Status | v1, companion to `docs/architecture.md` |
| Date | 2026-10-24 |
| Question answered | Which open-source skills, MCP servers or other tools help build this app — and which ones are not worth adding |

---

## 1. Verdict

**Claude Code alone can build this application well.** The stack chosen in the architecture (TypeScript, React, Hono, DynamoDB, CDK, Cognito, SES) is mainstream and thoroughly represented in the model's training; the project is small (one developer, ~5 milestones). No "token optimiser" product is needed — Claude Code already does the work those tools claim to do (prompt caching, auto-compaction, deferred tool loading, subagents).

Three categories of additions *do* pay for themselves, in this order:

1. **Project hygiene inside Claude Code** (free, ten minutes): a good `CLAUDE.md`, a permission allowlist, two hooks and three project-local skills. This is where most token waste is avoided.
2. **Two documentation MCP servers** (free): AWS Knowledge (official, remote, no credentials) and Context7 (library docs). They stop the single most expensive failure mode on this stack — code written against an API that changed (CDK constructs, Cognito `USER_AUTH`, Amplify v6, Hono) and then debugged for several turns.
3. **The gstack skills already installed** — several map directly onto milestones (§4).

A fourth item is a **requirement of the brief**, not an option: the **local stack** — DynamoDB Local, Mailpit, one thin in-repo auth emulator and a tick runner — that lets the complete test suite, end-to-end journeys included, run on a laptop with no AWS account, so that the cloud is deployed only after a green local run (§5.1, architecture §11.4).

Everything else listed below is optional; §6 says what to skip and why.

---

## 2. Project hygiene in Claude Code (do this in M0)

### 2.1 `CLAUDE.md` (project root)

Keep it short (≤ 80 lines) and factual; it is loaded into every session. Contents:

- One-paragraph purpose + link to `docs/architecture.md` (do **not** paste the architecture in).
- Commands: `pnpm local:up` (Docker: DynamoDB Local, Mailpit), `pnpm dev` (api, auth emulator, web), `pnpm test` (the **complete local suite** — the only definition of "green"), `pnpm tick --now <iso>` (run the scheduler at a chosen instant), `pnpm bootstrap:therapist --stage local|dev|prod` (the only way to create the therapist account), `pnpm typecheck`, `pnpm lint`, `pnpm deploy:dev` (runs `pnpm test` first, then `cdk diff`/`deploy`/smoke). Mailpit UI at `http://localhost:8025`.
- The three conventions that are easy to violate: (a) templates (`.tsx`) contain no logic — no `useState`/`useEffect`, no `rxjs` import; (b) every endpoint and every view-model has a spec whose `describe`/`it` read as documentation (§3.3 of the architecture), and every UI flow is a **headless journey** (architecture §10.5) that drives real view-models against the in-process API and asserts the sequence of method calls, stream emissions, requests and emails — Playwright only checks template binding; (c) DynamoDB keys are built only in `apps/api/src/repo`.
- Where things live (the tree in architecture §5.1).
- Rules: never run `cdk deploy` directly — only `pnpm deploy:dev`, which refuses when tests are red; `prod` is deployed only by the pipeline; ask before changing `infra/` or adding a dependency; WhatsApp is a later option — no WhatsApp code in v1, only the `NotificationChannel` seam.

### 2.2 Permission allowlist — `.claude/settings.json`

Pre-approve the read-only and test commands so sessions do not stop for prompts: `pnpm test` (not `pnpm test:cloud*`, which hits the real `dev` Cognito and SES and stays on ask), `pnpm typecheck`, `pnpm lint`, `pnpm -r build`, `git status/diff/log`, read-only `git branch` forms, `cdk synth`, `cdk diff`, `docker compose up -d`, `pnpm local:up`, `pnpm tick*`. Allow rules are exact commands or trailing-wildcard prefixes only — a wildcard in the middle (`pnpm -F * build*`) matches any subcommand and is refused by a spec. Keep `pnpm deploy:*`, `git push`, `rm -rf`, the file-writing git flags (`--output`, `--ext-diff`) and `cdk … --app` on ask. Put the account-changing CDK commands (`deploy`, `watch`, `import`, `bootstrap`, `destroy`, `rollback`, `gc`, `refactor`, plain and via `npx`/`pnpm exec`/`pnpm dlx`) on **deny**, as a second layer to the hook below. The `/fewer-permission-prompts` skill generates this list from your own usage after a few sessions.

### 2.3 Hooks (two are enough)

- **PostToolUse on Edit/Write/MultiEdit of `*.ts|*.tsx|*.mts|*.cts`** (`.claude/hooks/on-ts-edit.mjs`) → `biome check --write <file>`, then the owning package's `typecheck` script; a file outside every package that the root tsconfig does not include is reported as unchecked. Type errors come back immediately instead of three turns later from a failing test run. Quiet on success; all steps share one deadline inside the hook timeout.
- **PreToolUse on Bash** (`.claude/hooks/block-cdk-deploy.mjs`) → **deny** any direct CDK command that changes an account (`deploy`, `watch`, `import`, `bootstrap`, `destroy`, `rollback`, `gc`, `refactor`), with the message "use `pnpm deploy:dev`, which runs the full local suite first; `prod` deploys only through the pipeline". It denies by default, **order-free and with no exemptions**: after shell-like normalisation (quotes and escapes removed, `$'…'` decoded, `${x:-word}`, braces and `$IFS` expanded, globs that could match the CLI counted as the CLI), a command whose text contains both a CDK CLI word and such a subcommand word, anywhere, is denied. Wrappers (`bash -lc`, `"$(…)"`, `npx -c`, `node -e`, `xargs`, heredocs) cannot hide a deploy, and a mere mention is denied too — such text goes through a file (`git commit -F`, `gh pr create --body-file`). Every structural parse and exemption tried during the WP0.1 reviews was bypassed, hence none. The rule lives in `.claude/hooks/lib/cdk-gate.mjs`. The edit hook runs a package `typecheck` script only when it is a plain `tsc` invocation. **Limit:** the gate reads command text only; a pre-approved command that runs repo-defined code (package scripts, compose files, the CDK app) is out of its reach — see the P1 item in `TODOS.md` before WP0.10 adds AWS credentials. It **fails closed**: unparseable input or an internal error denies, and `onFailure: "block"` blocks the command when the hook cannot run. This makes the brief's rule — deploy only after all local tests pass — mechanical rather than a matter of discipline. `pnpm deploy:dev` itself stays on the ask list (§2.2) so you see every deploy; the one-time `cdk bootstrap` (WP0.10) is run by the developer.

Configure with the `/update-config` skill (it writes `settings.json` hooks correctly).

### 2.4 Project-local skills — `.claude/skills/`

Small, repo-specific skills encode the repetitive patterns so they are generated right the first time and consistently:

| Skill | What it does | Why it saves tokens |
|---|---|---|
| `new-endpoint` | Scaffolds a Hono route with its Zod request/response schema in `packages/contracts`, the use case, the repository method, and the API spec file with `describe`/`it` titles from a one-line feature description | The endpoint pattern is identical 25 times; without a skill each one is re-derived from scratch |
| `new-page` | Scaffolds `XPage.tsx` (template only), `XViewModel.ts` extending `ViewModel` with `stream()`-tagged observables, `XViewModel.spec.ts`, route registration, strings keys | Enforces the MVVM rule and the view-model contract mechanically |
| `new-journey` | Scaffolds `J<n>-<slug>.journey.spec.ts` with the harness setup (actors, recorders, clock), a trace assertion skeleton and the entry in the journey catalogue (§10.4 group H) | Journeys share one shape; the skill keeps traces consistent so `docs/journeys.md` reads uniformly |
| `local-stack` | Starts containers and processes (`pnpm local:up && pnpm dev`), seeds data, checks health of api / auth emulator / Mailpit, prints URLs and the therapist's TOTP secret | Start-up has several moving parts; the skill knows the order and the health checks |
| `deploy-dev` | Runs `pnpm test` (complete local suite) and **stops if anything is red** → `cdk diff` summarised → `cdk deploy --context stage=dev` → smoke → report | Deploy loop is long and noisy; the skill knows which output lines matter and enforces the gate |

Write them after the first instance of each pattern exists (M0/M1) — the skill then points at the reference implementation instead of describing it.

### 2.5 Session habits that cut consumption

- Start each milestone task from `docs/architecture.md` sections by number ("implement §5.3 Book a slot") rather than re-explaining.
- Use **Sonnet 5.5** for mechanical work (renames, boilerplate from the skills, i18n strings) and **Opus 5.5** for features and debugging; keep Fable 5.1 for design decisions and reviews. Effort `high` for coding, `xhigh` for reviews — `max` is rarely worth it here.
- `/compact` at milestone boundaries; `/clear` between unrelated tasks.
- Run test suites with quiet reporters (`vitest --reporter=dot`, `--silent`) — a verbose Vitest run dumps thousands of tokens into context.
- Let subagents (Explore) do broad code searches; keep the main context for decisions.
- `.gitignore` `node_modules`, `cdk.out`, `dist`, `coverage` — Claude's searches respect it.

---

## 3. MCP servers worth adding

| Server | What it gives | Install | Verdict |
|---|---|---|---|
| **AWS Knowledge MCP** (official, AWS-hosted, no account or credentials, rate-limited) | `search_documentation`, `read_documentation`, `get_regional_availability`, `retrieve_skill` over current AWS docs, API refs, What's New, Well-Architected | `claude mcp add --transport http aws-knowledge https://knowledge-mcp.global.api.aws` | **Add.** The design uses recent features (CloudFront flat-rate plans Nov 2025, Cognito Essentials/`USER_AUTH`, Scheduler L2) where the model's prior may be stale |
| **Context7** (Upstash, open source) | Version-specific docs for npm libraries: Hono, `@hono/zod-openapi`, Amplify v6 Auth, `aws-jwt-verify`, date-fns v4, RxJS, Vitest, Playwright, CDK constructs | `claude mcp add --transport http context7 https://mcp.context7.com/mcp` | **Add.** Cheap insurance against invented API signatures |
| **AWS IaC MCP** (awslabs; replaces the deprecated CDK MCP) | CDK best-practice guidance, construct examples, CloudFormation docs, security validation (cdk-nag style) | `uvx awslabs.aws-iac-mcp-server@latest` (needs Python/uv) | Optional — useful during M0 when the CDK stacks are written; can be removed afterwards |
| **DynamoDB MCP** (awslabs) | Data-modelling guidance and validation of access patterns | `uvx awslabs.dynamodb-mcp-server@latest` | Optional — the model in architecture §6 is already designed; use it once to review, then drop |
| **AWS Pricing MCP** (awslabs) | Live price lookups, cost estimates | `uvx awslabs.aws-pricing-mcp-server@latest` | Optional — handy for re-checking §12 before launch |
| **CloudWatch MCP** (awslabs) | Query logs and alarms from the session | `uvx awslabs.cloudwatch-mcp-server@latest` with the dev profile | Optional, from M2 on — debugging the notifier without copy-pasting log lines |

Notes:

- Each server adds tool definitions to context. Claude Code defers tool schemas until needed (ToolSearch), so the standing cost is low, but still enable only what the current milestone uses (`claude mcp remove` is instant).
- awslabs servers are stdio/Python; the AWS Knowledge server is the only one that needs nothing installed. awslabs has announced an "Agent Toolkit for AWS" as the successor to these servers — check the repository README when starting M0 in case installation names changed: https://github.com/awslabs/mcp

---

## 4. Skills already installed (gstack) — where they fit

| Milestone / moment | Skill | Use |
|---|---|---|
| Before writing the implementation plan | `/plan-eng-review` | Engineering review of `docs/architecture.md` + the plan: sequencing, risks, test strategy |
| Optional, same moment | `/plan-ceo-review` | Challenges scope — useful to confirm M2 (email-only) is a launchable product |
| Before building the UI (M1) | `/design-consultation` → `/design-html` | Typography, colour, spacing for a mobile-first calendar; produces the HTML/CSS base the templates follow |
| During M1–M3, every PR | `/review` | Pre-merge review of the diff |
| Every PR | `/ship` | Tests, review, version bump, changelog, PR — the repo's release routine |
| M1 onwards, UI work | `/qa` and `/browse` | Drive the SPA on the local stack headlessly, click through client and therapist journeys (codes and emails visible in Mailpit), fix what breaks — complements Playwright for exploratory testing, still with zero cloud |
| M2 (notifications) | `/investigate` | Systematic root-cause debugging when a notification does not arrive |
| M3 | `/cso` | Security review of the whole system against architecture §9 before `prod` |
| M3 | `/design-review` | Visual consistency pass on the finished pages |
| After launch | `/document-release`, `/retro` | Keep docs in sync; weekly retrospective |
| Any time something is destructive | `/careful`, `/freeze` | Guardrails while touching `infra/` or `prod` |

Also built in: `/code-review` (correctness-focused), `/security-review` (branch-level), `/simplify` after a feature lands, `/fewer-permission-prompts` for §2.2.

---

## 5. Libraries and developer tools (not Claude-specific, but they reduce effort)

| Need | Choice | Why it helps a Claude-driven build |
|---|---|---|
| API framework | **Hono** + `@hono/zod-openapi` | One declaration gives validation, types, OpenAPI; in-process `app.request()` makes API specs trivial |
| Validation / contracts | **Zod** | Shared by web and API; generates OpenAPI; readable schemas the model writes reliably |
| Lambda utilities | **Powertools for AWS Lambda (TypeScript)** — Logger, Tracer, Metrics | Structured logs with redaction, one-liner instrumentation |
| JWT | **aws-jwt-verify** | Official AWS library, caches JWKS, works with Cognito claims |
| DynamoDB access | `@aws-sdk/lib-dynamodb` (document client) | Keep it thin; a repository layer per entity. ElectroDB is an optional step up if key handling becomes noisy |
| Local DynamoDB | `amazon/dynamodb-local` via `docker compose` | Real conditional writes and transactions in specs and e2e (it never raises `TransactionConflict`: the `FaultInjectingDynamo` double covers that path) |
| Local email | **Mailpit** (Docker) + `nodemailer` for the `SmtpEmailChannel` | Every email visible in a UI; REST API lets Playwright read one-time codes and assert notifications |
| Local auth emulator | `jose` (RS256 JWT + JWKS), `otplib` (TOTP) — in-repo, ~300 lines | Same claims and flows as Cognito without the cloud; verified by shared contract specs |
| Local async invoke | `AsyncInvoker` port: in-process `setImmediate` call locally, `Lambda.invoke(Event)` in the cloud | The real `notifier` code runs after every commit locally; no stream emulation needed (architecture D6) |
| Local orchestration | Docker Compose + pnpm scripts (`local:up`, `dev`, `tick`, `seed`, `bootstrap:therapist`) | One command to a working system; same containers in CI |
| Dates | **date-fns v4 + @date-fns/tz** | Explicit timezone type; DST-correct slot generation |
| Front end | React 19, Vite, RxJS 7, React Router, typed Italian strings module (no i18n framework), Tailwind v4 | See architecture §7; i18next and PWA were trimmed in the eng review |
| OAC body signing | WebCrypto `crypto.subtle.digest('SHA-256')` in the SPA fetch wrapper → `x-amz-content-sha256` | Required for CloudFront OAC to sign requests with a body to the Lambda Function URL (architecture §4.4) |
| Typed API client | `openapi-typescript` + `openapi-fetch` | Generated from the API's OpenAPI; a contract change breaks the build, not production |
| Auth client | `aws-amplify` (Auth category only) | Implements `USER_AUTH` / `EMAIL_OTP`, TOTP setup, token refresh |
| Tests | **Vitest**, Testing Library, **Playwright** (3–4 binding journeys only; optionally **MSW** for isolated template tests) | One config language; behaviour is proven by the headless journeys, so the browser suite stays tiny and fast |
| Headless journeys | `packages/testkit`: in-process fetch adapter to Hono `app.request`, `ObservableRecorder`, `TraceRecorder`, `JourneyHarness`, journey report renderer (~400 lines, in-repo) | Real view-models + real API + DynamoDB Local in one Node process; traces rendered to `docs/journeys.md`; surface-coverage check fails `pnpm test` on an untested view-model member (architecture §10.5) |
| Lint/format | **Biome** | One fast tool for lint + format; a custom rule (or ESLint `no-restricted-imports` if preferred) bans `rxjs`/`useState` in `pages/` |
| Infra | **AWS CDK v2** with `NodejsFunction` (esbuild) | TypeScript, bundling built in; `aws-cdk-lib/assertions` for security assertions |
| Spec report | Vitest JSON reporter + ~40-line script | Produces `docs/specs.md` — the "executable documentation" made visible |
| API docs | Scalar (static HTML from OpenAPI) | Zero-dependency `docs/api.html` |
| Monorepo | pnpm workspaces | Fast, strict; no need for Turborepo/Nx at this size |

### 5.1 Local stack — alternatives considered

The brief requires that everything be testable locally. The chosen stack (architecture §11.4) is DynamoDB Local + Mailpit + one thin in-repo auth emulator + a tick runner + an in-process async invoker. Alternatives:

| Alternative | Why not (or when) |
|---|---|
| **LocalStack** (community edition) | Emulates DynamoDB, SES, SSM, SQS, Lambda and more in one container, but **Cognito is Pro-only**, so it does not remove the need for an auth emulator; it is heavier and slower to start than DynamoDB Local + Mailpit. Worth considering later if you want the AWS-SDK path for SES exercised locally — it stores sent emails behind a local endpoint |
| **cognito-local** (open source Cognito emulator) | Its own README lists only `USER_PASSWORD_AUTH` as supported (verified during the eng review); it does not implement the choice-based `USER_AUTH` / email-OTP flow this app uses, so it cannot replace the in-repo emulator |
| **Mocks only** (no containers) | Would not exercise transactions, conditional writes, Streams or real email rendering; the local run would not mean "it works" |
| **SAM local / `cdk watch` hot-swap** | Both need an AWS account and deploy to it; they contradict the local-only rule. `cdk synth` + assertions + bundle smoke give the offline part of the same confidence |
| **MailHog** | Unmaintained; Mailpit is its maintained successor with a REST API |

---

## 6. Not recommended (and why)

| Tool / idea | Why skip it |
|---|---|
| Third-party "token optimiser" / prompt-compression layers | Claude Code already caches prompts, compacts context and defers tool schemas; these products add a proxy, a vendor and a failure mode for marginal gain on a small codebase |
| Semantic code-navigation MCPs (e.g. LSP-based servers) | Valuable on large legacy codebases; this repo will be a few hundred files with a clear structure — Grep/Glob plus `CLAUDE.md` is enough. Revisit if the codebase exceeds ~50 k lines |
| Playwright MCP | gstack's `/browse` and `/qa` already provide headless browsing; Playwright itself stays as the e2e test runner |
| Full AWS API MCP (`awslabs.aws-api-mcp-server`) | Gives the agent arbitrary AWS CLI power; with a single account holding `prod`, that is more blast radius than value. Use the CDK pipeline and the narrow CloudWatch/Pricing servers instead |
| Any WhatsApp tooling now (Meta/Twilio SDKs, template managers) | WhatsApp is deferred (architecture D14, §12.1). When it is added, the Meta Graph API is a plain `fetch` behind the existing `NotificationChannel`; Twilio is the fallback if Meta onboarding stalls. Nothing to install in v1 |
| Component libraries (MUI, Ant) | Heavy, opinionated, and they push logic into templates; Tailwind + a handful of own components keeps the MVVM rule intact |
| Gherkin/Cucumber | Decided against: descriptive Vitest titles plus the generated spec report give the same readability with one test runner |

---

## 7. Setup checklist for M0

1. **Local stack first** (architecture §11.4): `docker-compose.yml` with DynamoDB Local and Mailpit, the auth emulator, the tick runner, the in-process async invoker, the bootstrap CLI and the seed. `pnpm test` must run green on a laptop before any CDK bootstrap or deploy.
2. `CLAUDE.md`, `.claude/settings.json` allowlist, the two hooks — including the `cdk deploy` block (§2).
3. `claude mcp add` AWS Knowledge and Context7 (§3). Add IaC MCP only while writing `infra/`.
4. Run `/plan-eng-review` on the architecture and the implementation plan before coding.
5. After the first endpoint, first page and first journey exist, write the `new-endpoint`, `new-page`, `new-journey`, `local-stack` and `deploy-dev` skills (§2.4).
6. Adopt `/ship` as the PR routine from the first PR; `/cso` before the first `prod` deploy.

---

### Sources

- awslabs MCP servers (list, deprecations, remote endpoints): https://github.com/awslabs/mcp
- AWS Knowledge MCP server (remote, no auth, tools): https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server
- Using AWS MCP servers with Claude Code: https://builder.aws.com/content/39tZA5QHRDqisSTJj9dsuKV8ZZW/improving-your-aws-development-workflow-on-claude-code-with-mcp-servers
