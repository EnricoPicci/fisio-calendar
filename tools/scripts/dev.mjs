#!/usr/bin/env node
// `pnpm dev`: the local Node processes of docs/architecture.md §11.4, each in watch mode, with
// their output prefixed. The API on http://127.0.0.1:3000/api/v1, the auth emulator on
// http://127.0.0.1:9100/local; the web app joins in WP0.7. Ctrl-C stops all of them, and one
// exiting stops the others. Needs `pnpm local:up` (DynamoDB Local) first.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const processes = [
  { name: 'api', entry: 'apps/api/src/runtime/local.ts' },
  { name: 'auth', entry: 'tools/local/auth-emulator/src/server.ts' },
];

// tsx's CLI under this Node, not through `pnpm exec`, which does not pass SIGTERM on.
const tsx = fileURLToPath(import.meta.resolve('tsx/cli'));

const children = processes.map(({ name, entry }) => {
  const child = spawn(process.execPath, [tsx, 'watch', entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line) console.log(`[${name}] ${line}`);
    });
  }
  child.on('exit', (code) => {
    console.log(`[${name}] exited (${code ?? 'signal'})`);
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
