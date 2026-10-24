import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'infra',
    include: ['{bin,lib,test}/**/*.spec.ts'],
  },
});
