#!/usr/bin/env node
// Claude Code PostToolUse hook (Edit|Write|MultiEdit). After a .ts/.tsx file is written:
//   1. `biome check --write <file>` — format + safe lint fixes;
//   2. typecheck the workspace package that owns the file (its `typecheck` script, run with
//      node_modules/.bin on PATH — no pnpm needed). A file that belongs to no package is checked
//      by the root tsconfig only if that tsconfig includes it; otherwise it is reported as
//      unchecked rather than passed silently.
// Silent when everything passes. Remaining Biome diagnostics, type errors and timeouts are
// returned to Claude as additional context, so they surface immediately instead of in a later
// test run. All steps share one deadline inside the hook's 90 s budget (.claude/settings.json);
// each runs in its own process group, killed as a whole when it finishes, at the deadline, or
// when Claude Code stops the hook, so a chained script cannot leave a tsc running.
// The typecheck script runs without a Bash call or a permission prompt, so only a plain `tsc`
// invocation (optionally several joined by `&&`) is run; any other script is reported as not run.
// Paths are compared as real paths (case-correct on macOS), so a symlink or a differently cased
// path cannot point the hook outside the project.
// See docs/tooling-and-skills.md §2.3.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const MAX_LINES = 60;
const MAX_OUTPUT = 1_000_000;
const BUDGET_MS = 80_000;
const PLAIN_TSC = /^\s*tsc(?:\s+[\w./=:-]+)*(?:\s*&&\s*tsc(?:\s+[\w./=:-]+)*)*\s*$/;
const deadline = Date.now() + BUDGET_MS;

const groups = new Set();
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    for (const pid of groups) killGroup(pid);
    process.exit(1);
  });
}

const input = readStdinJson();
const filePath = input?.tool_input?.file_path;
if (typeof filePath !== 'string' || !/\.(?:ts|tsx|mts|cts)$/.test(filePath)) process.exit(0);

const root = realpath(resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd()));
const requested = resolve(root, filePath);
if (!existsSync(requested)) process.exit(0);
const file = realpath(requested);
if (!isInsideRoot(file)) process.exit(0);
const rel = relative(root, file);
if (rel.split(sep).includes('node_modules')) process.exit(0);

const problems = [];

// 1. Biome on the edited file.
const biome = join(root, 'node_modules', '.bin', 'biome');
if (existsSync(biome)) {
  report(`biome check ${rel}`, await run(biome, ['check', '--write', file], { cwd: root }));
}

// 2. Typecheck the owning package (nearest package.json with a `typecheck` script).
const pkgDir = owningPackage(dirname(file));
if (pkgDir === root) {
  const tsc = join(root, 'node_modules', '.bin', 'tsc');
  if (existsSync(tsc) && existsSync(join(root, 'tsconfig.json'))) {
    const listed = await run(tsc, ['-p', 'tsconfig.json', '--listFilesOnly'], { cwd: root });
    if (timedOut(listed) || listed.status !== 0) {
      report('tsc (root) --listFilesOnly', listed);
    } else if (
      !listed.stdout
        .split('\n')
        .some((line) => line.trim() && realpath(resolve(root, line.trim())) === file)
    ) {
      problems.push(
        `typecheck: ${rel} is not checked by any typecheck — it is outside every workspace package and not included by the root tsconfig.json. Move it into a package or add it to a tsconfig.`,
      );
    } else {
      report('tsc (root)', await run(tsc, ['--noEmit', '-p', 'tsconfig.json'], { cwd: root }));
    }
  }
} else if (pkgDir) {
  report(`typecheck ${relative(root, pkgDir)}`, await runPackageScript(pkgDir, 'typecheck'));
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
        if (typeof pkg.scripts?.typecheck === 'string') return current;
      } catch {
        // unreadable manifest: keep walking up
      }
    }
    if (current === root) break;
    current = dirname(current);
  }
  return undefined;
}

async function runPackageScript(pkgDir, name) {
  // Same thing `pnpm run <name>` does, minus pnpm: the package's script with the package's and
  // the workspace root's node_modules/.bin prepended to PATH. Deliberately pnpm-free: the hook
  // must work before `corepack enable` has put pnpm on PATH.
  let script;
  try {
    script = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).scripts[name];
  } catch (error) {
    return { status: 1, stdout: '', stderr: `not run: package.json unreadable (${error.message})` };
  }
  if (typeof script !== 'string' || !PLAIN_TSC.test(script)) {
    return {
      status: 1,
      stdout: '',
      stderr: `not run: the typecheck script is not a plain tsc command (${JSON.stringify(script)}). This hook runs it without a permission prompt, so anything else is refused; run it yourself.`,
    };
  }
  const bins = [join(pkgDir, 'node_modules', '.bin'), join(root, 'node_modules', '.bin')];
  return run('sh', ['-c', script], {
    cwd: pkgDir,
    env: { ...process.env, PATH: `${bins.join(':')}:${process.env.PATH ?? ''}` },
  });
}

function run(command, args, options) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.resolve({
      status: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
      skipped: true,
    });
  }
  return new Promise((done) => {
    const child = spawn(command, args, {
      ...options,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) groups.add(child.pid);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      groups.delete(child.pid);
      done(result);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    const timer = setTimeout(() => {
      killGroup(child.pid);
      // A process that left the group may still hold the pipes: stop waiting for them.
      child.stdout.destroy();
      child.stderr.destroy();
      settle({ status: null, signal: 'SIGKILL', stdout, stderr });
    }, remaining);
    child.on('error', (error) => {
      settle({ status: null, signal: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (status, signal) => {
      killGroup(child.pid); // background children of a finished script do not outlive it
      settle({ status, signal, stdout, stderr });
    });
  });
}

function killGroup(pid) {
  try {
    if (pid) process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

function timedOut(result) {
  return result.signal === 'SIGKILL';
}

function realpath(path) {
  try {
    return realpathSync.native(path);
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
