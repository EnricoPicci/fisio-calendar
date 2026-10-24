import { defineConfig } from 'vitest/config';

// `pnpm test` is the complete local suite (docs/architecture.md §11.4): each package that owns
// specs is a Vitest project with its own vitest.config.ts (add `tools/*` here when they get
// specs of their own). Reporters are quiet on purpose (docs/tooling-and-skills.md §2.5): only
// failures print their output.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'infra'],
    reporters: ['dot'],
    silent: 'passed-only',
    passWithNoTests: true,
  },
});
