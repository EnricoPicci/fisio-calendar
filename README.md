# Fisio Calendar

Booking calendar for a single physiotherapist and about 200 clients. The therapist publishes
availability rules for the studio and the pool; clients book and free slots from their phones;
confirmations, cancellations, reminders and a daily digest go out by email.

TypeScript monorepo: React SPA, Hono API on AWS Lambda, DynamoDB, Cognito, SES, CDK. Everything
runs and is tested locally.

## Layout

```
apps/web        React SPA: pages (templates only), view-models, services, journeys
apps/api        API Lambda: http, use cases, repositories, notifier, identity, handlers
packages/       shared libraries: domain, contracts, testkit (see packages/README.md)
infra/          CDK stacks (Stateful, App, Edge), assertions, bundle smoke
tools/          local stack, therapist bootstrap CLI, repo scripts
e2e/            Playwright binding journeys
docs/           architecture, implementation plan, generated specs, journeys, OpenAPI
```

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
