import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api',
    include: ['{src,test}/**/*.spec.ts'],
    // API specs run against DynamoDB Local (architecture §10.3).
    globalSetup: ['@fisio/testkit/global-setup'],
  },
});
