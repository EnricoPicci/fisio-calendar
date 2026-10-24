import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath } from './run-node';

const scripts = (
  JSON.parse(readFileSync(repoPath('package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

describe('Root scripts — the pnpm entry points listed in the root package.json', () => {
  // Value: protects=the dev deploy is gated on a green suite; fails_when=`pnpm test &&` dropped or turned into `;`; why_new=no test reads root scripts; seam=none; no_claim=what the WP0.10 deploy does
  it('runs the whole test suite before the dev deploy, and stops if it fails', () => {
    expect(scripts['deploy:dev']).toMatch(/^pnpm test && /);
  });

  // Value: protects=placeholder messages name the right script and WP; fails_when=a script passes a wrong/missing name or WP id; why_new=not-yet.spec only runs the script directly; seam=none; no_claim=WP id is the correct one
  it('has every placeholder name itself and the work package that delivers it', () => {
    const placeholders = Object.entries(scripts).filter(([, command]) =>
      command.includes('tools/scripts/not-yet.mjs'),
    );
    expect(placeholders.length).toBeGreaterThan(0);
    for (const [name, command] of placeholders) {
      const args = command.split('tools/scripts/not-yet.mjs')[1]?.trim().split(/\s+/) ?? [];
      expect(args[0], name).toBe(name);
      expect(args[1], name).toMatch(/^WP\d+\.\d+$/);
    }
  });
});
