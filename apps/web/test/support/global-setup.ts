import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

/**
 * Global setup of the `web` and `web-surface` projects: one results directory per Vitest run,
 * provided to the workers of both (`resultsDir()` in `results.ts`) and removed when the run ends.
 * Both projects' setups run in the run's main process and share the directory through its
 * Vitest instance, so `web-surface` judges only what this run's spec files reported (none when
 * the web project did not run), and two runs at once never touch each other's files.
 */
const RESULTS = fileURLToPath(
  new URL('../../node_modules/.cache/fisio-test-results/', import.meta.url),
);

const holder = globalThis as { __fisioResultsDirs?: WeakMap<object, string> };
holder.__fisioResultsDirs ??= new WeakMap<object, string>();
const runs = holder.__fisioResultsDirs;

export default function setup(project: TestProject): () => void {
  let dir = runs.get(project.vitest);
  if (!dir) {
    dir = join(RESULTS, randomUUID());
    runs.set(project.vitest, dir);
  }
  project.provide('fisioResultsDir', dir);
  const owned = dir;
  return () => rmSync(owned, { recursive: true, force: true });
}
