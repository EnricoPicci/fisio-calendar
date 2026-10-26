import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the spec workers hand to the checks that run after them (the `web-surface` project, which
 * Vitest runs once every other project has finished): one JSON file per journey and per spec
 * file, under a results directory of the run, which the application's global setup provides to
 * the workers and removes when the run ends.
 */
export type ResultKind = 'journeys' | 'surface';

export function writeResult(dir: string, kind: ResultKind, key: string, data: unknown): void {
  const folder = join(dir, kind);
  mkdirSync(folder, { recursive: true });
  const name = createHash('sha256').update(key).digest('hex').slice(0, 16);
  writeFileSync(join(folder, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
}

export function readResults<T>(dir: string, kind: ResultKind): T[] {
  const folder = join(dir, kind);
  let names: string[];
  try {
    names = readdirSync(folder).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names.sort().map((name) => JSON.parse(readFileSync(join(folder, name), 'utf8')) as T);
}
