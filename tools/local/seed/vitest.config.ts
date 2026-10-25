import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'seed',
    include: ['{src,test}/**/*.spec.ts'],
    // The seed writes the emulator's users and the client items to DynamoDB Local.
    globalSetup: ['@fisio/testkit/global-setup'],
  },
});
