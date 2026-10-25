import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configDefaults } from 'vitest/config';
import { repoPath } from './run-node';

interface Config {
  default: {
    test?: {
      projects?: string[];
      include?: string[];
      exclude?: string[];
      globalSetup?: string | string[];
    };
  };
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

  // Value: protects=a project whose specs use DynamoDB Local creates the test table itself, so `vitest --project <name>` works alone; fails_when=a new project uses the testkit DynamoDB client without listing the testkit global setup; why_new=a full run hides it (testkit's setup creates the shared table); seam=none; no_claim=that the setup succeeds
  it('each project whose specs use DynamoDB Local lists the testkit global setup', async () => {
    const rootConfig = (await import(repoPath('vitest.config.ts'))) as Config;
    const configs = (rootConfig.default.test?.projects ?? []).flatMap((pattern) =>
      globSync(pattern, { cwd: root }),
    );
    // This file names the helpers in the pattern below, so it does not count as a user.
    const thisFile = fileURLToPath(import.meta.url);
    const usesDynamo = /\b(testDocumentClient|localDynamoClient|ensureTable|TEST_TABLE)\b/;
    // The package export, or a relative path that resolves to the testkit file itself.
    const testkitSetup = join(root, 'packages/testkit/src/global-setup.ts');
    const isTestkitSetup = (entry: string, dir: string) =>
      entry === '@fisio/testkit/global-setup' || join(dir, entry) === testkitSetup;
    const missing: string[] = [];
    let checked = 0;
    for (const config of configs) {
      const { default: project } = (await import(join(root, config))) as Config;
      const dir = join(root, dirname(config));
      const specs = globSync(['**/*.spec.{ts,tsx}', 'test/**/*.ts'], {
        cwd: dir,
        exclude: (p) => p.split('/').some((part) => skipped.has(part)),
      });
      const sources = specs.map((file) => join(dir, file)).filter((path) => path !== thisFile);
      if (!sources.some((path) => usesDynamo.test(readFileSync(path, 'utf8')))) continue;
      checked += 1;
      const setup = [project.test?.globalSetup ?? []].flat();
      if (!setup.some((entry) => isTestkitSetup(entry, dir))) missing.push(config);
    }
    expect(checked).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
