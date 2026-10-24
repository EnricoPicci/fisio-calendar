#!/usr/bin/env node
// Claude Code PostToolUse hook (Edit|Write|MultiEdit). After a .ts/.tsx file is written:
//   1. `biome check --write <file>` — format + safe lint fixes;
//   2. typecheck the workspace package that owns the file (its `typecheck` script, run with
//      node_modules/.bin on PATH — no pnpm needed). A file that belongs to no package is checked
//      by the root tsconfig only if that tsconfig includes it; otherwise it is reported as
//      unchecked rather than passed silently.
// Silent when everything passes. Remaining Biome diagnostics, type errors and timeouts are
// returned to Claude as additional context, so they surface immediately instead of in a later
// test run. All steps share one deadline inside the hook's 90 s budget (.claude/settings.json),
// so a slow step is reported as timed out instead of the whole hook being killed silently.
// See docs/tooling-and-skills.md §2.3.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const MAX_LINES = 60;
const BUDGET_MS = 80_000;
const deadline = Date.now() + BUDGET_MS;

const input = readStdinJson();
const filePath = input?.tool_input?.file_path;
if (typeof filePath !== 'string' || !/\.(?:ts|tsx|mts|cts)$/.test(filePath)) process.exit(0);

const root = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const file = resolve(root, filePath);
if (!isInsideRoot(file) || !existsSync(file)) process.exit(0);
const rel = relative(root, file);
if (rel.split(sep).includes('node_modules')) process.exit(0);

const problems = [];

// 1. Biome on the edited file.
const biome = join(root, 'node_modules', '.bin', 'biome');
if (existsSync(biome)) {
  report(`biome check ${rel}`, run(biome, ['check', '--write', file], { cwd: root }));
}

// 2. Typecheck the owning package (nearest package.json with a `typecheck` script).
const pkgDir = owningPackage(dirname(file));
if (pkgDir === root) {
  const tsc = join(root, 'node_modules', '.bin', 'tsc');
  if (existsSync(tsc) && existsSync(join(root, 'tsconfig.json'))) {
    const listed = run(tsc, ['-p', 'tsconfig.json', '--listFilesOnly'], { cwd: root });
    const real = realpath(file);
    if (timedOut(listed)) {
      report('tsc (root) --listFilesOnly', listed);
    } else if (
      listed.status === 0 &&
      !listed.stdout
        .split('\n')
        .some((line) => line.trim() && realpath(resolve(root, line.trim())) === real)
    ) {
      problems.push(
        `typecheck: ${rel} is not checked by any typecheck — it is outside every workspace package and not included by the root tsconfig.json. Move it into a package or add it to a tsconfig.`,
      );
    } else {
      report('tsc (root)', run(tsc, ['--noEmit', '-p', 'tsconfig.json'], { cwd: root }));
    }
  }
} else if (pkgDir) {
  report(`typecheck ${relative(root, pkgDir)}`, runPackageScript(pkgDir, 'typecheck'));
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

function isInsideRoot(path) {
  return path === root || path.startsWith(root + sep);
}

function owningPackage(dir) {
  let current = dir;
  while (isInsideRoot(current)) {
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
  // the workspace root's node_modules/.bin prepended to PATH. Deliberately pnpm-free: the hook
  // must work before `corepack enable` has put pnpm on PATH.
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const bins = [join(pkgDir, 'node_modules', '.bin'), join(root, 'node_modules', '.bin')];
  return run('sh', ['-c', pkg.scripts[name]], {
    cwd: pkgDir,
    env: { ...process.env, PATH: `${bins.join(':')}:${process.env.PATH ?? ''}` },
  });
}

function run(command, args, options) {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    return { status: null, signal: 'SIGKILL', stdout: '', stderr: '', skipped: true };
  return spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    timeout: remaining,
    killSignal: 'SIGKILL',
  });
}

function timedOut(result) {
  return result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL';
}

function realpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function report(label, result) {
  if (timedOut(result)) {
    const what = result.skipped ? 'not run: the time budget of the hook was used up' : 'timed out';
    problems.push(`${label}\n${what} (budget ${BUDGET_MS / 1000} s); result unknown`);
  } else if (result.status !== 0) {
    problems.push(`${label}\n${trim(`${result.stdout ?? ''}${result.stderr ?? ''}`)}`);
  }
}

function trim(text) {
  const lines = text.trim().split('\n');
  return lines.length > MAX_LINES
    ? `${lines.slice(0, MAX_LINES).join('\n')}\n… (${lines.length - MAX_LINES} more lines)`
    : lines.join('\n');
}
