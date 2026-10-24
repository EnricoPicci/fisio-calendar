import { describe, expect, it } from 'vitest';
import { repoPath, runNode } from './run-node';

const SCRIPT = repoPath('tools/scripts/not-yet.mjs');

describe('Placeholder scripts — a root script whose work package has not landed', () => {
  it('fails, so a chain such as `pnpm test && …` never reports a step that did not run', () => {
    const run = runNode(SCRIPT, { args: ['tick', 'WP0.6'] });
    expect(run.status).toBe(1);
  });

  it('names the script and the work package that delivers it', () => {
    const run = runNode(SCRIPT, { args: ['bootstrap:therapist', 'WP0.5'] });
    expect(run.stderr).toContain('pnpm bootstrap:therapist');
    expect(run.stderr).toContain('WP0.5');
  });
});
