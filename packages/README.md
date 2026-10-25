# packages

Shared libraries. Nothing here is deployed on its own: `apps/api`, `apps/web`, `tools` and the
specs import these packages, so every definition used by more than one of them lives here once.

| Package | Role | Depends on |
|---|---|---|
| [domain](domain/README.md) | Business rules in pure TypeScript | nothing internal |
| [contracts](contracts/README.md) | The agreement between web and API | domain |
| [testkit](testkit/README.md) | Test harness and doubles, never shipped | infra (table definition), tools/local (DynamoDB Local); domain and contracts later |

Dependencies point one way: apps depend on packages, never the reverse. See
[architecture §5.1](../docs/architecture.md#51-code-structure-monorepo-pnpm-workspaces).
