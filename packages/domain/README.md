# @fisio/domain

The business rules, as pure functions: slot ids, Europe/Rome time helpers, the `Clock` port, the
notification state machine, and later rules, slot generation and booking policies. Also the
ports more than one package implements (`AsyncInvoker` with
`InProcessAsyncInvoker`, `NotificationChannel` with the email adapters' shared `isSingleMailbox`
and `NOTIFICATION_KEY_HEADER`, and `IdentityProvider` with its errors), and `isErrorNamed` for recognising its errors across module copies.

- **Never here:** I/O, AWS SDKs, HTTP, React, or reading the current time outside `systemClock`: inject a `Clock`.
- **Depends on:** no internal package. Only `date-fns` and `@date-fns/tz`.
- **Specs:** `test/`, run in milliseconds at a fixed clock.
- **Details:** architecture [§5.1](../../docs/architecture.md#51-code-structure-monorepo-pnpm-workspaces),
  [§5.4](../../docs/architecture.md#54-notification-pipeline-transactional-outbox-explicit-state-machine),
  [§5.5](../../docs/architecture.md#55-time-handling).
