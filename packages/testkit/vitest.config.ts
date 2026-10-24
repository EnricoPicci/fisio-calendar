import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'testkit',
    include: ['{src,test}/**/*.spec.ts'],
    globalSetup: ['src/global-setup.ts'],
  },
});
