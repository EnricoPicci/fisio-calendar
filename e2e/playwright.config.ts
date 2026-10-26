import { defineConfig, devices } from '@playwright/test';

/**
 * The Playwright binding journeys (docs/architecture.md §10.1, layer E): the full local stack of
 * `pnpm dev` in a real browser, codes read from Mailpit. They prove the templates bind to the
 * view-models and the SPA loads and routes; behaviour itself is proven by the headless journeys.
 * `pnpm test` runs them after Vitest; a `pnpm dev` already running is reused.
 */
const WEB_URL = 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.binding.ts',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['dot'], ['github']] : 'dot',
  timeout: 30_000,
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Pixel 7'], browserName: 'chromium' } }],
  webServer: {
    command: 'pnpm dev',
    cwd: '..',
    url: WEB_URL,
    // Locally a running `pnpm dev` is reused (it must be this checkout's); CI starts its own.
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // `pnpm dev` logs every child on stdout: in CI a crashed api or emulator shows its cause.
    stdout: process.env.CI ? 'pipe' : 'ignore',
    stderr: 'pipe',
  },
});
