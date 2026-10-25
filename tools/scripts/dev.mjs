#!/usr/bin/env node
// `pnpm dev`: the local Node processes of docs/architecture.md §11.4, each in watch mode, with
// their output prefixed. The API on http://127.0.0.1:3000/api/v1, the auth emulator on
// http://127.0.0.1:9100/local, the web app (Vite, proxying /api to the API) on
// http://127.0.0.1:5173. Ctrl-C stops all of them, and one exiting stops the others (with exit
// code 1 if it failed). Under `tsx watch` a crash at startup does not exit: tsx prints the error
// and waits for a change, so watch the prefixed output. Needs `pnpm local:up` (DynamoDB Local)
// first.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// CLIs under this Node, not through `pnpm exec`, which does not pass SIGTERM on.
const tsx = fileURLToPath(import.meta.resolve('tsx/cli'));
const webDir = fileURLToPath(new URL('../../apps/web/', import.meta.url));
// Vite does not export its bin: find it through the package manifest the web app resolves.
const webRequire = createRequire(`${webDir}package.json`);
const vitePackage = webRequire.resolve('vite/package.json');
const vite = join(dirname(vitePackage), webRequire(vitePackage).bin.vite);

const processes = [
  { name: 'api', args: [tsx, 'watch', 'apps/api/src/runtime/local.ts'] },
  { name: 'auth', args: [tsx, 'watch', 'tools/local/auth-emulator/src/server.ts'] },
  { name: 'web', args: [vite, '--clearScreen', 'false'], cwd: webDir },
];

const children = processes.map(({ name, args, cwd }) => {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Whole lines only, so a chunk split mid-line keeps one prefix.
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      if (line) console.log(`[${name}] ${line}`);
    });
  }
  child.on('exit', (code) => {
    console.log(`[${name}] exited (${code ?? 'signal'})`);
    if (!stopping && code !== 0) process.exitCode = 1;
    stopAll();
  });
  return child;
});

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}

process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
