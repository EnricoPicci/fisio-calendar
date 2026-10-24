# Fisio Calendar

Booking calendar for a single physiotherapist and about 200 clients. The therapist publishes
availability rules for the studio and the pool; clients book and free slots from their phones;
confirmations, cancellations, reminders and a daily digest go out by email.

TypeScript monorepo: React SPA, Hono API on AWS Lambda, DynamoDB, Cognito, SES, CDK. Everything
runs and is tested locally.

## Layout

```
apps/web        SPA: src/pages (templates) · src/viewmodels · src/services · test/journeys
apps/api        Lambda: src/http · src/usecases · src/repo · src/notify · src/identity · src/handlers · src/runtime
packages/       domain (pure TS) · contracts (Zod, errors, strings) · testkit (harness, recorders, doubles)
infra/          CDK: Stateful, App, Edge stacks · assertions · bundle smoke
tools/          local (docker-compose, auth emulator, tick, seed) · bootstrap (therapist CLI) · scripts
e2e/            Playwright binding journeys
docs/           architecture, implementation plan, generated specs/journeys/openapi
```

Shared libraries are described in [packages/README.md](packages/README.md); the full tree is in
[architecture §5.1](docs/architecture.md#51-code-structure-monorepo-pnpm-workspaces).

## Getting started

Requires Node 24 (`.nvmrc`), pnpm via `corepack enable`, and Docker.

```sh
pnpm install
pnpm test        # the complete local suite: the only definition of green
pnpm typecheck
pnpm lint
```

## Documentation

- [Architecture](docs/architecture.md): the design, decisions and spec catalogue.
- [Implementation plan](docs/implementation-plan.md): work packages, one per session.
- [Tooling and skills](docs/tooling-and-skills.md): hooks, permissions, the deploy gate.
- [CLAUDE.md](CLAUDE.md): commands, conventions and rules for working in the repo.
