# @fisio/e2e

The Playwright **binding journeys** (architecture §10.1 layer E, §10.5): a few journeys in a real
browser against the full local stack of `pnpm dev`, proving that the templates bind to the
view-models and that the SPA loads and routes. Behaviour itself is proven by the headless journeys
in `apps/web/test/journeys`; keep this suite to the binding journeys of §10.4 group H.

- **Runs in `pnpm test`**, after Vitest (`tools/scripts/test.mjs`; a filtered `pnpm test <filter>`
  skips it). Alone: `pnpm --filter @fisio/e2e test`. Needs `pnpm local:up`; Playwright starts
  `pnpm dev`, or reuses one already running on :5173.
- **Once per machine:** `pnpm --filter @fisio/e2e exec playwright install chromium` (CI installs
  it with `--with-deps`).
- **Files:** `tests/*.binding.ts` (not `*.spec.ts`: they run on the real clock against the
  long-lived local table, outside Vitest's conventions). `global-setup.ts` runs `pnpm seed`
  (idempotent; on a fresh stack the therapist's credentials go to
  `node_modules/.cache/fisio-seed-credentials.txt`) and waits for the API and the auth emulator;
  one-time codes are read from Mailpit with `@fisio/testkit/mailpit`. CI never reuses a running
  `pnpm dev`; locally one on :5173 is reused, so make sure it is this checkout's.
- **Journeys:** `sign-in.binding.ts`: the sign-in page enters a code and lands on the client home.
