import { basename } from 'node:path';
import { lastValueFrom, type Observable } from 'rxjs';
import { expect, it } from 'vitest';
import type { JourneyHarness } from './harness';
import { writeResult } from './results';
import { renderTrace } from './trace';

/**
 * `journey` and `journey$` (docs/architecture.md §10.5): one Vitest test per journey, each on a
 * harness of its own (fresh tenant, channel and clock). After the body, `finish()` disposes what
 * is still open and fails the journey when a subscription survived; then the rendered trace is
 * written for `docs/journeys.md`, marked passed or failed.
 */
export interface FinishingHarness extends JourneyHarness {
  /** Disposes every actor still open; throws when a subscription stays open. */
  finish(): Promise<void>;
}

export interface JourneyResult {
  /** `J1`, `J8-a`: the catalogue id the title starts with (architecture §10.4 group H). */
  readonly id: string;
  readonly title: string;
  /** The spec file's name. */
  readonly file: string;
  readonly passed: boolean;
  readonly lines: readonly string[];
}

export interface JourneyOptions {
  /** Where the results go (see `results.ts`). */
  readonly resultsDir: string;
}

const ID = /^(J\d+(?:-[a-z])?) — /;

export function defineJourneys<H extends FinishingHarness>(
  create: () => H,
  options: JourneyOptions,
) {
  function journey(title: string, body: (j: H) => Promise<void>): void {
    const id = ID.exec(title)?.[1];
    if (!id) throw new Error(`A journey title starts with its catalogue id: "J1 — …" (${title})`);
    it(title, async () => {
      const file = basename(expect.getState().testPath ?? 'unknown');
      const j = create();
      let passed = false;
      try {
        await body(j);
        await j.finish();
        passed = true;
      } finally {
        j.close();
        const lines = renderTrace(j.trace.entries, { redactions: j.redactions });
        // Keyed by file and title: two files' journeys of the same title keep both traces.
        writeResult(options.resultsDir, 'journeys', `${file}#${title}`, {
          id,
          title,
          file,
          passed,
          lines,
        } satisfies JourneyResult);
      }
    }, 20_000);
  }

  /** A journey written as one pipeline; the test waits for it to complete. */
  function journey$(title: string, body: (j: H) => Observable<unknown>): void {
    journey(title, async (j) => {
      await lastValueFrom(body(j), { defaultValue: undefined });
    });
  }

  return { journey, journey$ };
}
