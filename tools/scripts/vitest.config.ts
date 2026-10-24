import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'tooling',
    include: ['test/**/*.spec.ts'],
  },
});
