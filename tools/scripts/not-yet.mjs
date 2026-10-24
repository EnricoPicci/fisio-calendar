#!/usr/bin/env node
// Placeholder target for root scripts whose implementation arrives in a later work package.
// Usage (from package.json): node tools/scripts/not-yet.mjs <script> <WP>
const [script, wp] = process.argv.slice(2);
console.error(
  `pnpm ${script}: not available yet. It is delivered by ${wp} (see docs/implementation-plan.md).`,
);
process.exit(1);
