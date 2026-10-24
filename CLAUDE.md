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
| `pnpm local:up` | Docker: DynamoDB Local (:8000), Mailpit (UI `http://localhost:8025`) |
| `pnpm dev` | api, auth emulator, web on the local stack |
| `pnpm test` | **the complete local suite — the only definition of "green"** (domain, API, view-models, headless journeys, templates, infra assertions, bundle smoke, Playwright binding) |
| `pnpm typecheck` / `pnpm lint` / `pnpm lint:fix` | `tsc --noEmit` per package / Biome check / Biome fix |
| `pnpm tick --now <iso>` | run the scheduler (`jobs` handler) at a chosen instant |
| `pnpm seed` | therapist (via bootstrap) + clients + rules + slots on the local stack |
| `pnpm bootstrap:therapist --stage local\|dev\|prod` | the only way to create the therapist account |
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
   `packages/domain`, `ErrorCode` in `packages/contracts`) — never hand-built elsewhere.
4. Spec files are `*.spec.ts(x)` under `src/` or `test/`; every spec runs at a fixed `Clock`.

## Where things live (architecture §5.1)

```
apps/web        SPA: src/pages (templates) · src/viewmodels · src/services · test/journeys
apps/api        Lambda: src/http · src/usecases · src/repo · src/notify · src/identity · src/handlers · src/runtime
packages/       domain (pure TS) · contracts (Zod, errors, strings) · testkit (harness, recorders, doubles)
infra/          CDK: Stateful, App, Edge stacks · assertions · bundle smoke
tools/          local (docker-compose, auth emulator, tick, seed) · bootstrap (therapist CLI) · scripts
e2e/            Playwright binding journeys
docs/           architecture, implementation plan, generated specs/journeys/openapi
```

## Rules

- **Never run `cdk deploy` directly** (a hook blocks it, and `watch`/`import`/`bootstrap`/
  `destroy`/`rollback` too). Only `pnpm deploy:dev`, which runs the full local suite first. `prod`
  is deployed only by the pipeline with manual approval; the one-time `cdk bootstrap` is yours.
- The deploy hook fails closed and denies by default: a mention of those commands outside a
  commit/PR message, a grep pattern or a heredoc fed to `cat`/`git`/`gh` is blocked too. If
  **every** Bash call is blocked, `node` is not on the hook's PATH: restart Claude Code from a
  shell where `node -v` prints 24.x. Last resort: `"disableAllHooks": true` in
  `.claude/settings.local.json` (turns off both hooks; the permission deny list still applies) —
  remove it once node is found.
- Ask before changing `infra/` or adding a dependency.
- WhatsApp is a later option: no WhatsApp code in v1, only the `NotificationChannel` seam.
- Never widen a work package: out-of-scope findings go to `TODOS.md` or a new WP line, same PR.
- Quiet test output: `vitest` runs with the dot reporter and `silent: 'passed-only'`; keep it so.
- Done = `pnpm test`, `pnpm typecheck`, `pnpm lint` green locally; then `/review`, `/ship`.
