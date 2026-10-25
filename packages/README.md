# packages

Shared libraries. Nothing here is deployed on its own: `apps/api`, `apps/web`, `tools` and the
specs import these packages, so every definition used by more than one of them lives here once.

| Package | Role | Depends on |
|---|---|---|
| [domain](domain/README.md) | Business rules in pure TypeScript; ports shared by several packages | nothing internal |
| [contracts](contracts/README.md) | The agreement between web and API | domain |
| [testkit](testkit/README.md) | Test harness and doubles, never shipped | domain (ports), infra (table definition), tools/local (DynamoDB Local); never apps/* |

Dependencies point one way: apps depend on packages, never the reverse. See
[architecture §5.1](../docs/architecture.md#51-code-structure-monorepo-pnpm-workspaces).
