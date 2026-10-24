import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'web',
    include: ['{src,test}/**/*.spec.{ts,tsx}'],
  },
});
