#!/usr/bin/env node
// `pnpm test`: the complete local suite (docs/architecture.md §11.4). Vitest first (every
// project, the web-surface checks last), then the Playwright binding journeys against `pnpm dev`
// (started, or reused when already running). Arguments go to Vitest only, and a filtered run
// (`pnpm test SignIn`) skips Playwright, so a quick run stays quick; `pnpm test` alone is green
// only when both pass.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const vitest = run('pnpm', ['exec', 'vitest', 'run', ...args]);
if (vitest !== 0) process.exit(vitest);
if (args.length > 0) {
  console.error('Playwright binding journeys skipped (arguments given): run `pnpm test` alone');
  process.exit(vitest);
}
// `--fail-if-no-match`: a renamed or missing e2e package is red, not a silently skipped suite.
process.exit(run('pnpm', ['--filter', '@fisio/e2e', '--fail-if-no-match', 'test']));
