# @fisio/contracts

The agreement between the web app and the API: Zod schemas and DTO types, the `ErrorCode`
catalogue (HTTP status and `urn:fisio:error:<code>`), and the typed Italian strings.

- **Never here:** business rules (they belong in domain) or anything that runs only on one side.
- **Depends on:** `@fisio/domain` for formats it owns (dates, times, `SlotId`), and `zod`.
- **Rule:** a new error code goes in the architecture table first, then in `src/errors.ts`;
  every code needs a message in `src/strings/it.ts` (enforced by the compiler).
- **Details:** architecture [§5.2](../../docs/architecture.md#52-api),
  [§7.3](../../docs/architecture.md#73-stack).
