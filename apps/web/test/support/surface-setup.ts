import { relative } from 'node:path';
import { instrumentSurface, writeResult } from '@fisio/testkit';
import { afterAll, expect } from 'vitest';
import { ViewModel } from '../../src/app/view-model';
import { resultsDir, webRoot } from './results';
import { VIEW_MODEL_BASES, VIEW_MODEL_CLASSES } from './view-model-classes';

/**
 * Setup file of the web project: logs which view-model members each spec file exercises, for
 * the surface-coverage check in `test/surface` (architecture §10.5).
 */
const surface = instrumentSurface({
  base: ViewModel,
  bases: VIEW_MODEL_BASES,
  classes: VIEW_MODEL_CLASSES,
});

afterAll(() => {
  const file = relative(webRoot(), expect.getState().testPath ?? 'unknown');
  writeResult(resultsDir(), 'surface', file, { file, ...surface.log() });
});
