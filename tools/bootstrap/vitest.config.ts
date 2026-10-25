import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'bootstrap',
    include: ['{src,test}/**/*.spec.ts'],
    // The bootstrap specs run the emulator and the Settings repository on DynamoDB Local.
    globalSetup: ['@fisio/testkit/global-setup'],
  },
});
