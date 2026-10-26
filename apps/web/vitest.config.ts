import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'web',
    include: ['{src,test}/**/*.spec.{ts,tsx}'],
    // The checks over the whole run live in their own project (vitest.surface.config.ts).
    exclude: [...configDefaults.exclude, 'test/surface/**'],
    // View-model and service specs run on Node; template binding specs opt into jsdom with a
    // `// @vitest-environment jsdom` first line. The auth emulator used in-process by the
    // `LocalAuthService` spec and the journeys needs DynamoDB Local (architecture §10.3).
    globalSetup: ['@fisio/testkit/global-setup', 'test/support/global-setup.ts'],
    // Logs each spec file's use of view-models for the surface-coverage check (§10.5).
    setupFiles: ['test/support/surface-setup.ts'],
    env: { FISIO_WEB_ROOT: fileURLToPath(new URL('.', import.meta.url)) },
  },
});
