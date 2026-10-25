import { defineConfig } from 'vitest/config';

// `pnpm test` is the complete local suite (docs/architecture.md §11.4): each package that owns
// specs is a Vitest project with its own vitest.config.ts. Reporters are quiet on purpose
// (docs/tooling-and-skills.md §2.5): only failures print their output.
export default defineConfig({
  test: {
    // Globs name the config files, not folders: a folder glob such as `packages/*` also
    // matches files like packages/README.md, which Vitest rejects at startup.
    projects: [
      'packages/*/vitest.config.ts',
      'apps/*/vitest.config.ts',
      'infra/vitest.config.ts',
      'tools/scripts/vitest.config.ts',
      'tools/local/*/vitest.config.ts',
      'tools/bootstrap/vitest.config.ts',
    ],
    reporters: ['dot'],
    silent: 'passed-only',
    passWithNoTests: true,
  },
});
