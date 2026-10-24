import { globSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configDefaults } from 'vitest/config';
import { repoPath } from './run-node';

interface Config {
  default: { test?: { projects?: string[]; include?: string[]; exclude?: string[] } };
}

const root = repoPath('');
const skipped = new Set(['node_modules', '.git', 'dist', 'cdk.out', 'coverage']);
// Repository-relative paths. The root e2e/ holds the Playwright binding specs (architecture
// §10.5), which Playwright runs, not Vitest.
const isCandidate = (path: string) =>
  path !== 'e2e' && !path.startsWith('e2e/') && !path.split('/').some((part) => skipped.has(part));

async function projectSpecFiles(): Promise<Set<string>> {
  const rootConfig = (await import(repoPath('vitest.config.ts'))) as Config;
  const configs = (rootConfig.default.test?.projects ?? []).flatMap((pattern) =>
    globSync(pattern, { cwd: root }),
  );
  const files = new Set<string>();
  for (const config of configs) {
    const { default: project } = (await import(join(root, config))) as Config;
    const dir = dirname(config);
    // The files Vitest collects: the project's include minus its exclude and Vitest's defaults.
    const exclude = [...configDefaults.exclude, ...(project.test?.exclude ?? [])];
    for (const pattern of project.test?.include ?? []) {
      for (const file of globSync(pattern, { cwd: join(root, dir), exclude })) {
        files.add(join(dir, file));
      }
    }
  }
  return files;
}

describe('Vitest projects: every spec file runs in `pnpm test`', () => {
  // Value: protects=a spec file is never silently left out of the suite; fails_when=a spec sits outside every project's include, or a project's exclude drops it; why_new=the suite only proved that the globs start; seam=none; no_claim=that the project's specs pass; the exclude and root e2e/ branches can fail only once a project sets an exclude or Playwright specs exist
  it('each *.spec.ts(x) in the repository belongs to a Vitest project listed in the root config', async () => {
    const inProjects = await projectSpecFiles();
    const all = globSync('**/*.spec.{ts,tsx}', {
      cwd: root,
      exclude: (p) => !isCandidate(p),
    });
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((file) => !inProjects.has(file))).toEqual([]);
  });
});
