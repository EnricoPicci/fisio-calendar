import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The SPA's build and dev server (docs/architecture.md §7.3, §11.4). The dev server listens on
 * the origin the auth emulator and the API's invitation links expect (`LOCAL_WEB_ORIGINS` in
 * tools/local/auth-emulator/src/config.ts) and proxies `/api` to the local API, the way
 * CloudFront serves `/api/*` from the same origin in the cloud: no CORS, and the fetch wrapper's
 * `x-amz-content-sha256` path is exercised locally too.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
});
