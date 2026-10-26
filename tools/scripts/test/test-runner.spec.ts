import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath, runNode } from './run-node';

const SCRIPT = repoPath('tools/scripts/test.mjs');

/**
 * Runs `tools/scripts/test.mjs` with a stand-in `pnpm` first on the PATH, which logs its
 * arguments and fails the Vitest or the Playwright step when told to.
 */
function runWithFakePnpm(args: string[], vitestStatus = 0, e2eStatus = 0) {
  const bin = mkdtempSync(join(tmpdir(), 'fisio-test-runner-'));
  const log = join(bin, 'calls.log');
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in exec\\ vitest*) exit ${vitestStatus};; --filter\\ @fisio/e2e*) exit ${e2eStatus};; esac\nexit 0\n`,
  );
  chmodSync(join(bin, 'pnpm'), 0o755);
  writeFileSync(log, '');
  const run = runNode(SCRIPT, {
    args,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
  });
  return {
    status: run.status,
    calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
  };
}

describe('`pnpm test` — the complete local suite (architecture §11.4)', () => {
  // Value: protects=`pnpm test` alone runs the Playwright binding journeys after a green Vitest run; fails_when=the runner skips Playwright, runs it after a red Vitest, or loses Vitest's exit code; why_new=WP0.8 adds Playwright to the suite; seam=a stand-in pnpm on PATH; no_claim=that the journeys pass
  it('runs Vitest, then the Playwright binding journeys; a red Vitest run stops there', () => {
    expect(runWithFakePnpm([])).toEqual({
      status: 0,
      calls: ['exec vitest run', '--filter @fisio/e2e --fail-if-no-match test'],
    });
    expect(runWithFakePnpm([], 1)).toEqual({ status: 1, calls: ['exec vitest run'] });
  });

  // Value: protects=a red binding journey makes `pnpm test` red; fails_when=the runner exits with Vitest's status, or 0, after Playwright failed; why_new=the WP0.8 review (the stand-in let Playwright always pass); seam=a stand-in pnpm on PATH; no_claim=Playwright's own exit codes
  it('a red Playwright run makes `pnpm test` red', () => {
    expect(runWithFakePnpm([], 0, 1)).toEqual({
      status: 1,
      calls: ['exec vitest run', '--filter @fisio/e2e --fail-if-no-match test'],
    });
  });

  // Value: protects=a filtered run (`pnpm test SignIn`) passes its filter to Vitest and stays quick; fails_when=arguments reach Playwright or the full suite runs anyway; why_new=WP0.8 runner; seam=a stand-in pnpm on PATH; no_claim=Vitest's filtering
  it('passes arguments to Vitest only and skips Playwright on a filtered run', () => {
    expect(runWithFakePnpm(['SignIn', '--project', 'web'])).toEqual({
      status: 0,
      calls: ['exec vitest run SignIn --project web'],
    });
  });
});
