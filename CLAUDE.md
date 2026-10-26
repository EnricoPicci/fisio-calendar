# Fisio Calendar

Booking calendar for a single physiotherapist and her ~200 clients: she publishes availability
rules (studio and pool), clients book and free slots from their phones, email notifications
(confirmations, cancellations, reminders, digest) go out through a transactional outbox.
TypeScript monorepo: React SPA + Hono on Lambda + DynamoDB + Cognito + SES, CDK, all testable
locally. The design is `docs/architecture.md`; the work breakdown is `docs/implementation-plan.md`
(one work package per session: "Implement WP1.3 from docs/implementation-plan.md").

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | pnpm 12 via `corepack enable` (version pinned in `package.json`); develop on Node 24 (`.nvmrc`). The Lambdas run Node 22 (architecture §4.3), so code must run on 22 too: `engines.node` stays `>=22.12` on purpose |
| `pnpm local:up` / `local:down` | Docker: DynamoDB Local (:8000), Mailpit (UI `http://localhost:8025`), then the `fisio-local` table (Node >= 22.18) / stop them (in-memory: data is dropped) |
| `pnpm dev` | api, auth emulator, web on the local stack, in watch mode: the api on `http://127.0.0.1:3000/api/v1`, the auth emulator on `http://127.0.0.1:9100/local` (one-time codes and every other local email land in Mailpit), the web app on `http://127.0.0.1:5173` (Vite, `/api` proxied to the api; sign in with a seeded client's email or the therapist's password + TOTP) |
| `pnpm openapi` | regenerate `docs/openapi.json` from the route declarations, then the SPA's `apps/web/src/services/api.generated.ts`; a spec fails while either is out of date |
| `pnpm test` | **the complete local suite — the only definition of "green"** (domain, API, view-models, headless journeys, surface coverage, templates, infra assertions, bundle smoke, then Playwright binding against `pnpm dev`, started or reused); needs `pnpm local:up` running and, once per machine, `pnpm --filter @fisio/e2e exec playwright install chromium`. It rewrites `docs/journeys.md`: commit it. `pnpm test <filter>` passes the filter to Vitest and skips Playwright |
| `pnpm typecheck` / `pnpm lint` / `pnpm lint:fix` | `tsc --noEmit` per package / Biome check / Biome fix |
| `pnpm tick --now <iso>` | run the scheduler's tick (`jobs` code, notifier in-process, email to Mailpit) at a chosen UTC instant; also `POST /__dev/tick {now}` |
| `pnpm seed` | therapist (via bootstrap, setup completed: prints password and TOTP secret) + a dozen clients on the local stack; rules and slots arrive in WP1.2 |
| `pnpm bootstrap:therapist --stage local\|dev\|prod --email <addr>` | the only way to create the therapist account; prints a one-time setup link until she has a password and an enrolled authenticator (`dev`/`prod` need `COGNITO_USER_POOL_ID` and `WEB_ORIGIN`) |
| `pnpm deploy:dev` | `pnpm test` first, then `cdk diff` / `deploy` / smoke on `dev`; refuses when red |
| `pnpm test:cloud:auth` / `test:cloud:email` | contract specs against the `dev` Cognito pool / SES |

Scripts whose work package has not landed yet print which WP delivers them and exit 1.

## Conventions (easy to violate)

1. **Templates contain no logic.** Files under `apps/web/src/pages` are binding only: no
   `useState`, no `useEffect`, no `rxjs` import. Everything observable lives in a view-model.
2. **Specs are the documentation.** Every endpoint and every view-model has a spec whose
   `describe`/`it` titles come from the catalogue in architecture §10.4 and read as acceptance
   criteria; specs assert error codes, never message text. Every UI flow is a **headless journey**
   (architecture §10.5): real view-models against the in-process API, asserting the sequence of
   method calls, stream emissions, requests and emails. Playwright only checks template binding.
3. **DynamoDB keys are built only in `apps/api/src/repo`**, from domain ids (`SlotId` in
   `packages/domain`, `ErrorCode` in `packages/contracts`) — never hand-built elsewhere. The one
   exception is the auth emulator's own `IDP#<poolId>` items (`tools/local/auth-emulator/src/keys.ts`).
4. Spec files are `*.spec.ts(x)` under `src/` or `test/`; every spec runs at a fixed `Clock`.

## Where things live

The folder layout is in `README.md`; each package's role and dependency rules are in
`packages/README.md` and the package's own README.

## Rules

- **Never run `cdk deploy` directly** (a hook blocks it, and `watch`/`import`/`bootstrap`/
  `destroy`/`rollback`/`gc`/`refactor` too). Only `pnpm deploy:dev`, which runs the full local
  suite first. `prod` is deployed only by the pipeline with manual approval; the one-time
  `cdk bootstrap` is yours.
- The deploy hook has **no exemptions** and ignores word order: any Bash command whose text
  contains both the CDK CLI word and one of those subcommands is denied, even in a commit
  message, grep pattern or heredoc. Put such text in a file written with Write/Edit and pass the
  file: `git commit -F <file>`, `gh pr create --body-file <file>`. Both hooks and the
  permission lists are described in `docs/tooling-and-skills.md` §2.2–2.3.
- Package `typecheck` scripts must be plain `tsc` invocations: the edit hook runs nothing else.
- The deploy hook fails closed. If **every** Bash call is blocked, `node` is not on the hook's
  PATH: restart Claude Code from a
  shell where `node -v` prints 24.x. Last resort: `"disableAllHooks": true` in
  `.claude/settings.local.json` (turns off both hooks; the permission deny list still applies) —
  remove it once node is found.
- Ask before changing `infra/` or adding a dependency.
- WhatsApp is a later option: no WhatsApp code in v1, only the `NotificationChannel` seam.
- Never widen a work package: out-of-scope findings go to `TODOS.md` or a new WP line, same PR.
- Quiet test output: `vitest` runs with the dot reporter and `silent: 'passed-only'`; keep it so.
- Done = `pnpm test`, `pnpm typecheck`, `pnpm lint` green locally; then `/review`, `/ship`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. Route only to skills in the session's available-skills list; answer directly for quick questions or small scoped edits.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
