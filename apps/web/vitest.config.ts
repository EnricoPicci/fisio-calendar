import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'web',
    include: ['{src,test}/**/*.spec.{ts,tsx}'],
    // View-model and service specs run on Node; template binding specs opt into jsdom with a
    // `// @vitest-environment jsdom` first line. The auth emulator used in-process by the
    // `LocalAuthService` spec (and the journeys, WP0.8) needs DynamoDB Local (architecture §10.3).
    globalSetup: ['@fisio/testkit/global-setup'],
  },
});
