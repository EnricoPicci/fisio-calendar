import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { webRoot } from '../support/results';

/** The spec files of `folder` (relative to the web package) whose names end in `suffix`. */
export function specFiles(folder: string, suffix: string): string[] {
  return readdirSync(join(webRoot(), folder))
    .filter((name) => name.endsWith(suffix))
    .map((name) => `${folder}/${name}`)
    .sort();
}

/** View-model specs and journeys: the spec files whose use of view-models counts (§10.5). */
export function countedSpecFiles(): string[] {
  return [
    ...specFiles('src/viewmodels', '.spec.ts'),
    ...specFiles('test/journeys', '.journey.spec.ts'),
  ];
}
