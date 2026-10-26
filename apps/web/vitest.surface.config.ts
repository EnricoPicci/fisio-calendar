import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The checks over a whole run of the web project (architecture §10.5): surface coverage and the
 * journey report. `groupOrder: 1` makes Vitest run this project after every other one, so the
 * web project's spec workers have written their results (`test/support/results.ts`).
 */
export default defineConfig({
  test: {
    name: 'web-surface',
    include: ['test/surface/**/*.spec.ts'],
    sequence: { groupOrder: 1 },
    // The same results directory as the web project's workers (one per run).
    globalSetup: ['test/support/global-setup.ts'],
    env: { FISIO_WEB_ROOT: fileURLToPath(new URL('.', import.meta.url)) },
  },
});
