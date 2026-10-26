import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Before the binding journeys: the seeded clients exist (`pnpm seed` is idempotent), and the API
 * and the auth emulator of `pnpm dev` answer (Playwright's `webServer` waits for the web app only).
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Git-ignored (under node_modules); readable by the developer only. */
const CREDENTIALS = join(ROOT, 'node_modules/.cache/fisio-seed-credentials.txt');
const READY = [
  'http://127.0.0.1:3000/api/v1/health',
  'http://127.0.0.1:9100/local/.well-known/jwks.json',
];

export default async function globalSetup(): Promise<void> {
  // stderr shows why a seed failed; stdout (the therapist's credentials) stays out of the log.
  const seed = execFileSync('pnpm', ['--silent', 'seed'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // A first seed prints the therapist's password and TOTP secret once: keep them for the developer.
  if (seed.includes('TOTP secret')) {
    mkdirSync(dirname(CREDENTIALS), { recursive: true });
    writeFileSync(CREDENTIALS, seed, { mode: 0o600 });
    // `mode` applies only when the file is created: tighten one left by an earlier stack too.
    chmodSync(CREDENTIALS, 0o600);
    console.log(
      `First seed of this local stack: the therapist's credentials are in ${CREDENTIALS}`,
    );
  }
  const deadline = Date.now() + 30_000;
  for (const url of READY) {
    for (;;) {
      const ok = await fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
        (response) => response.ok,
        () => false,
      );
      if (ok) break;
      if (Date.now() > deadline) throw new Error(`${url} did not answer: is \`pnpm dev\` running?`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
