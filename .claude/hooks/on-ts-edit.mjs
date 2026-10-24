#!/usr/bin/env node
// Claude Code PostToolUse hook (Edit|Write). After a .ts/.tsx file is written:
//   1. `biome check --write <file>` — format + safe lint fixes;
//   2. typecheck the workspace package that owns the file (its `typecheck` script, run with
//      node_modules/.bin on PATH — no pnpm needed).
// Silent when everything passes. Remaining Biome diagnostics and type errors are returned to
// Claude as additional context, so they surface immediately instead of in a later test run.
// See docs/tooling-and-skills.md §2.3.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const MAX_LINES = 60;

const input = readStdinJson();
const filePath = input?.tool_input?.file_path;
if (typeof filePath !== 'string' || !/\.(?:ts|tsx|mts|cts)$/.test(filePath)) process.exit(0);

const root = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const file = resolve(root, filePath);
if (!file.startsWith(root + sep) || !existsSync(file)) process.exit(0);
const rel = relative(root, file);

const problems = [];

// 1. Biome on the edited file.
const biome = join(root, 'node_modules', '.bin', 'biome');
if (existsSync(biome)) {
  const r = spawnSync(biome, ['check', '--write', file], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) problems.push(`biome check ${rel}\n${trim(`${r.stdout}${r.stderr}`)}`);
}

// 2. Typecheck the owning package (nearest package.json with a `typecheck` script).
const pkgDir = owningPackage(dirname(file));
if (pkgDir === root) {
  const tsc = join(root, 'node_modules', '.bin', 'tsc');
  if (existsSync(tsc) && existsSync(join(root, 'tsconfig.json'))) {
    const r = spawnSync(tsc, ['--noEmit', '-p', 'tsconfig.json'], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) problems.push(`tsc (root)\n${trim(`${r.stdout}${r.stderr}`)}`);
  }
} else if (pkgDir) {
  const r = runPackageScript(pkgDir, 'typecheck');
  if (r.status !== 0) {
    problems.push(`typecheck ${relative(root, pkgDir)}\n${trim(`${r.stdout}${r.stderr}`)}`);
  }
}

if (problems.length > 0) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `Hook on-ts-edit found problems after editing ${rel}:\n\n${problems.join('\n\n')}`,
    },
  };
  console.log(JSON.stringify(out));
}

function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return undefined;
  }
}

function owningPackage(dir) {
  let current = dir;
  while (current.startsWith(root)) {
    const manifest = join(current, 'package.json');
    if (existsSync(manifest)) {
      if (current === root) return root;
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        if (pkg.scripts?.typecheck) return current;
      } catch {
        // unreadable manifest: keep walking up
      }
    }
    if (current === root) break;
    current = dirname(current);
  }
  return undefined;
}

function runPackageScript(pkgDir, name) {
  // Same thing `pnpm run <name>` does, minus pnpm: the package's script with the package's and
  // the workspace root's node_modules/.bin prepended to PATH.
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const bins = [join(pkgDir, 'node_modules', '.bin'), join(root, 'node_modules', '.bin')];
  return spawnSync('sh', ['-c', pkg.scripts[name]], {
    cwd: pkgDir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bins.join(':')}:${process.env.PATH ?? ''}` },
  });
}

function trim(text) {
  const lines = text.trim().split('\n');
  return lines.length > MAX_LINES
    ? `${lines.slice(0, MAX_LINES).join('\n')}\n… (${lines.length - MAX_LINES} more lines)`
    : lines.join('\n');
}
