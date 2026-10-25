# Fisio Calendar

Booking calendar for a single physiotherapist and about 200 clients. The therapist publishes
availability rules for the studio and the pool; clients book and free slots from their phones;
confirmations, cancellations, reminders and a daily digest go out by email.

TypeScript monorepo: React SPA, Hono API on AWS Lambda, DynamoDB, Cognito, SES, CDK. Everything
runs and is tested locally.

## Layout

```
apps/web        SPA: src/app (ViewModel base, hooks, DI, shell) · src/pages (templates) · src/viewmodels · src/services · test/journeys
apps/api        Lambda: src/http · src/usecases · src/repo · src/notify · src/identity · src/jobs · src/handlers · src/runtime (incl. the `pnpm tick` CLI)
packages/       domain (pure TS) · contracts (Zod, errors, strings) · testkit (harness, recorders, doubles)
infra/          CDK: Stateful, App, Edge stacks · assertions · bundle smoke
tools/          local (docker-compose; auth-emulator and seed packages; table and SMTP helpers) · bootstrap (therapist CLI) · openapi-types (SPA API types generator) · scripts
e2e/            Playwright binding journeys
docs/           architecture, implementation plan, generated specs/journeys/openapi
```

Shared libraries are described in [packages/README.md](packages/README.md); the full tree is in
[architecture §5.1](docs/architecture.md#51-code-structure-monorepo-pnpm-workspaces).

## Getting started

Requires Node 24 (`.nvmrc`), pnpm via `corepack enable`, and Docker.

```sh
pnpm install
pnpm local:up    # Docker: DynamoDB Local (:8000) and Mailpit (UI :8025), then the local table (Node >= 22.18)
pnpm test        # the complete local suite: the only definition of green (needs local:up)
pnpm seed        # the therapist (prints password + TOTP secret) and a dozen clients
pnpm dev         # the web app on http://127.0.0.1:5173, the API on :3000/api/v1, the auth emulator on :9100 (watch mode)
pnpm typecheck
pnpm lint
```

## Documentation

- [Architecture](docs/architecture.md): the design, decisions and spec catalogue.
- [Implementation plan](docs/implementation-plan.md): work packages, one per session.
- [Tooling and skills](docs/tooling-and-skills.md): hooks, permissions, the deploy gate.
- [CLAUDE.md](CLAUDE.md): commands, conventions and rules for working in the repo.
