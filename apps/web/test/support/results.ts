import { inject } from 'vitest';

/**
 * Where the web project's spec workers leave the journey traces and the surface logs for the
 * `web-surface` project, which Vitest runs after every other project (`sequence.groupOrder`):
 * a directory of this run only, which `global-setup.ts` provides to both projects' workers.
 */
declare module 'vitest' {
  export interface ProvidedContext {
    fisioResultsDir: string;
  }
}

/**
 * The web package root, against which spec files are named in the results. In the spec
 * workers it comes from the Vitest configs (`FISIO_WEB_ROOT`): under jsdom, `import.meta.url`
 * is not a file URL.
 */
export function webRoot(): string {
  const root = process.env.FISIO_WEB_ROOT;
  if (!root) throw new Error('FISIO_WEB_ROOT is unset: run the specs through the Vitest configs');
  return root;
}

/** This run's results directory. */
export function resultsDir(): string {
  return inject('fisioResultsDir');
}
