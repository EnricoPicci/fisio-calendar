import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'auth-emulator',
    include: ['{src,test}/**/*.spec.ts'],
    // The emulator keeps its users in DynamoDB Local (architecture §11.4).
    globalSetup: ['@fisio/testkit/global-setup'],
  },
});
