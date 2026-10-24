import { globSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath } from './run-node';

interface Config {
  default: { test?: { projects?: string[]; include?: string[] } };
}

const root = repoPath('');
const skipped = new Set(['node_modules', '.git', 'dist', 'cdk.out', 'coverage']);
const notSkipped = (path: string) => !path.split('/').some((part) => skipped.has(part));

async function projectSpecFiles(): Promise<Set<string>> {
  const rootConfig = (await import(repoPath('vitest.config.ts'))) as Config;
  const configs = (rootConfig.default.test?.projects ?? []).flatMap((pattern) =>
    globSync(pattern, { cwd: root }),
  );
  const files = new Set<string>();
  for (const config of configs) {
    const { default: project } = (await import(join(root, config))) as Config;
    const dir = dirname(config);
    for (const pattern of project.test?.include ?? []) {
      for (const file of globSync(pattern, {
        cwd: join(root, dir),
        exclude: (p) => !notSkipped(p),
      })) {
        files.add(join(dir, file));
      }
    }
  }
  return files;
}

describe('Vitest projects: every spec file runs in `pnpm test`', () => {
  // Value: protects=a spec file is never silently left out of the suite; fails_when=a spec sits outside every project's include (a new package without vitest.config.ts, or a folder the include misses); why_new=the suite only proved that the globs start; seam=none; no_claim=that the project's specs pass
  it('each *.spec.ts(x) in the repository belongs to a Vitest project listed in the root config', async () => {
    const inProjects = await projectSpecFiles();
    const all = globSync('**/*.spec.{ts,tsx}', {
      cwd: root,
      exclude: (p) => !notSkipped(p),
    });
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((file) => !inProjects.has(file))).toEqual([]);
  });
});
