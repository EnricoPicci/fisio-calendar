import { readResults, type SurfaceLog, surfaceMethods, uncoveredMembers } from '@fisio/testkit';
import { describe, expect, it } from 'vitest';
import { resultsDir } from '../support/results';
import { VIEW_MODEL_BASES, VIEW_MODEL_CLASSES } from '../support/view-model-classes';
import { SURFACE_ALLOWLIST } from './allowlist';
import { countedSpecFiles } from './files';

/**
 * The surface-coverage check (architecture §10.5). It runs in the `web-surface` project, after
 * the web project's spec files have each logged which view-model members they exercised
 * (`test/support/surface-setup.ts`).
 */
interface FileLog extends SurfaceLog {
  readonly file: string;
}

function union(logs: readonly FileLog[], pick: (log: FileLog) => SurfaceLog[keyof SurfaceLog]) {
  const merged: Record<string, string[]> = {};
  for (const log of logs) {
    for (const [cls, members] of Object.entries(pick(log))) {
      merged[cls] = [...new Set([...(merged[cls] ?? []), ...members])].sort();
    }
  }
  return merged;
}

describe('View-model surface coverage (architecture §10.5)', () => {
  const logs = readResults<FileLog>(resultsDir(), 'surface');
  const counted = new Set(countedSpecFiles());

  // Value: protects=the check below judges a complete run; fails_when=the web project was filtered or a spec file crashed before reporting, so missing members would be blamed on the wrong cause; why_new=first surface check; seam=the results directory; no_claim=which members are covered
  it('every view-model spec and journey of this run reported its view-model use', () => {
    const reported = new Set(logs.map((log) => log.file));
    expect(
      [...counted].filter((file) => !reported.has(file)),
      'spec files without a surface log: run the whole web project (pnpm test)',
    ).toEqual([]);
  });

  // Value: protects=no public method or stream of a view-model goes unexercised by a journey or view-model spec; fails_when=a member is added without a spec, or the allowlist keeps an entry that is covered now; why_new=first surface check (WP0.8); seam=prototype methods and stream() wrapped in the spec workers; no_claim=that the exercise asserts anything (review)
  it('every public method and stream of every view-model is exercised; the allowlist holds nothing stale', () => {
    const methods = Object.fromEntries(
      VIEW_MODEL_CLASSES.map((cls) => [cls.name, surfaceMethods(cls, VIEW_MODEL_BASES)]),
    );
    const result = uncoveredMembers({
      methods,
      // A stream declared anywhere is surface; only the counted spec files exercise it.
      streams: union(logs, (log) => log.streams),
      exercised: union(
        logs.filter((log) => counted.has(log.file)),
        (log) => log.exercised,
      ),
      allowlist: SURFACE_ALLOWLIST,
    });
    expect(VIEW_MODEL_CLASSES.length).toBeGreaterThan(0);
    expect(result.neverConstructed, 'view-models no spec constructs').toEqual([]);
    expect(result.uncovered, 'members no journey or view-model spec exercises').toEqual([]);
    expect(result.stale, 'allowlist entries that are exercised').toEqual([]);
  });
});
