import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoPath, runNode } from './run-node';

const HOOK = repoPath('.claude/hooks/on-ts-edit.mjs');

// A throwaway repository: a root manifest, one package whose typecheck passes and one whose
// typecheck fails. It has no node_modules, so the Biome and root-tsc steps are skipped and only
// the per-package typecheck is exercised; the real workspace is never touched.
let root: string;
// A directory next to the fixture whose path starts with the fixture's path (`<root>-sibling`).
let sibling: string;
// An unrelated directory elsewhere in the temp dir, holding a real .ts file in a failing package.
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'on-ts-edit-'));
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","private":true}');
  const pkg = (name: string, typecheck: string) => {
    mkdirSync(join(root, name, 'src'), { recursive: true });
    writeFileSync(
      join(root, name, 'package.json'),
      JSON.stringify({ name, private: true, scripts: { typecheck } }),
    );
    writeFileSync(join(root, name, 'src', 'index.ts'), 'export {};\n');
  };
  pkg('good', 'exit 0');
  pkg('bad', 'echo "src/index.ts(1,1): error TS2322: Type \'string\' is not assignable"; exit 2');
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  writeFileSync(join(root, 'bad', 'notes.md'), '# notes\n');
  writeFileSync(join(root, 'bad', 'src', 'view.tsx'), 'export {};\n');
  writeFileSync(join(root, 'bad', 'src', 'util.mts'), 'export {};\n');
  const failing = JSON.stringify({
    name: 'x',
    private: true,
    scripts: { typecheck: 'echo TS9999; exit 2' },
  });
  mkdirSync(join(root, 'bad', 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(root, 'bad', 'node_modules', 'x', 'package.json'), failing);
  writeFileSync(join(root, 'bad', 'node_modules', 'x', 'index.ts'), 'export {};\n');
  outside = mkdtempSync(join(tmpdir(), 'on-ts-edit-outside-'));
  mkdirSync(join(outside, 'src'), { recursive: true });
  writeFileSync(join(outside, 'package.json'), failing);
  writeFileSync(join(outside, 'src', 'index.ts'), 'export {};\n');
  sibling = `${root}-sibling`;
  mkdirSync(join(sibling, 'src'), { recursive: true });
  writeFileSync(join(sibling, 'package.json'), failing);
  writeFileSync(join(sibling, 'src', 'index.ts'), 'export {};\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(sibling, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function edit(filePath: string, toolName = 'Edit') {
  return runNode(HOOK, {
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    stdin: JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath } }),
  });
}

describe('Edit hook — typecheck the owning package after each .ts/.tsx edit', () => {
  it('stays silent when the owning package type-checks', () => {
    const run = edit('good/src/index.ts');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  });

  it('returns the type errors to Claude as additional context when the package does not', () => {
    const run = edit(join(root, 'bad/src/index.ts'), 'Write');
    expect(run.status).toBe(0);
    const output = JSON.parse(run.stdout).hookSpecificOutput;
    expect(output.hookEventName).toBe('PostToolUse');
    expect(output.additionalContext).toContain('typecheck bad');
    expect(output.additionalContext).toContain('TS2322');
  });

  // Value: protects=.tsx/.mts edits get typechecked; fails_when=extension filter narrows to .ts only; why_new=only .ts was exercised; seam=none; no_claim=.cts
  it.each([
    ['a .tsx file', 'bad/src/view.tsx'],
    ['a .mts file', 'bad/src/util.mts'],
  ])('also type-checks %s in the owning package', (_label, filePath) => {
    const run = edit(filePath);
    expect(run.status).toBe(0);
    const output = JSON.parse(run.stdout).hookSpecificOutput;
    expect(output.additionalContext).toContain('typecheck bad');
    expect(output.additionalContext).toContain('TS2322');
  });

  // Value: protects=each ignore guard (extension, existence, root prefix, node_modules); fails_when=a guard is removed or prefix check loses `+ sep`; why_new=old rows pass guardless; seam=none; no_claim=symlinks
  it.each([
    ['a non-TypeScript file', 'README.md'],
    ['a file that does not exist', 'good/src/missing.ts'],
    ['a real file outside the project, in a failing package', '<outside>/src/index.ts'],
    ['a non-TypeScript file in a failing package', 'bad/notes.md'],
    ['a missing .ts file in a failing package', 'bad/src/missing.ts'],
    ['a file under node_modules', 'bad/node_modules/x/index.ts'],
    ['a sibling directory whose path starts with the project path', '<sibling>/src/index.ts'],
  ])('ignores %s', (_label, filePath) => {
    const run = edit(filePath.replace('<sibling>', sibling).replace('<outside>', outside));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  });

  it('ignores hook input that is not valid JSON', () => {
    const run = runNode(HOOK, { cwd: root, stdin: 'not json' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  });
});

// A second throwaway repository with stub binaries in node_modules/.bin, so the Biome step and
// the root-tsconfig step run. The stub `biome` fails (80 lines of output) only for files under
// bad/; the stub `tsc` lists only the root vitest.config.ts and reports one error for it.
describe('Edit hook — Biome and the root tsconfig, with binaries installed', () => {
  let tooled: string;

  beforeAll(() => {
    tooled = mkdtempSync(join(tmpdir(), 'on-ts-edit-tooled-'));
    const bin = join(tooled, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stub(
      'biome',
      'case "$3" in */bad/*) i=1; while [ $i -le 80 ]; do echo "lint $i"; i=$((i+1)); done; exit 1;; esac\nexit 0',
    );
    stub(
      'tsc',
      [
        'for a in "$@"; do',
        // Like real tsc, the stub lists the resolved path (on macOS the temp dir is under the
        // /var -> /private/var symlink), so the hook must compare real paths to recognise it.
        `  if [ "$a" = "--listFilesOnly" ]; then echo '${join(realpathSync(tooled), 'vitest.config.ts')}'; exit 0; fi`,
        'done',
        "echo 'vitest.config.ts(1,1): error TS2322: boom'",
        'exit 2',
      ].join('\n'),
    );
    writeFileSync(join(tooled, 'package.json'), '{"name":"fixture","private":true}');
    writeFileSync(join(tooled, 'tsconfig.json'), '{}');
    writeFileSync(join(tooled, 'vitest.config.ts'), 'export default {};\n');
    writeFileSync(join(tooled, 'stray.ts'), 'export {};\n');
    const pkg = (name: string, typecheck: string) => {
      mkdirSync(join(tooled, name, 'src'), { recursive: true });
      writeFileSync(
        join(tooled, name, 'package.json'),
        JSON.stringify({ name, private: true, scripts: { typecheck } }),
      );
      writeFileSync(join(tooled, name, 'src', 'index.ts'), 'export {};\n');
    };
    pkg('good', 'exit 0');
    pkg('bad', 'echo "src/index.ts(1,1): error TS2322: Type mismatch"; exit 2');
  });

  afterAll(() => {
    rmSync(tooled, { recursive: true, force: true });
  });

  function editIn(filePath: string) {
    return runNode(HOOK, {
      cwd: tooled,
      env: { ...process.env, CLAUDE_PROJECT_DIR: tooled },
      stdin: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } }),
    });
  }

  // Value: protects=Biome failures reach Claude alongside type errors, trimmed to 60 lines; fails_when=biome step skipped, result dropped, or trim broken; why_new=no test had a biome binary; seam=none; no_claim=real biome
  it('reports remaining Biome diagnostics, trimmed, together with the package type errors', () => {
    const run = editIn('bad/src/index.ts');
    expect(run.status).toBe(0);
    const context: string = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain(`biome check ${join('bad', 'src', 'index.ts')}`);
    expect(context).toContain('lint 60');
    expect(context).not.toContain('lint 61');
    expect(context).toContain('… (20 more lines)');
    expect(context).toContain('typecheck bad');
    expect(context).toContain('TS2322');
  });

  it('stays silent when Biome and the package typecheck both pass', () => {
    const run = editIn('good/src/index.ts');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  });

  // Value: protects=root files are checked by the root tsconfig, never passed silently; fails_when=root branch skipped or listFilesOnly match inverted; why_new=root branch untested; seam=none; no_claim=real tsc output format
  it('type-checks a root-level file with the root tsconfig when it includes the file', () => {
    const run = editIn('vitest.config.ts');
    expect(run.status).toBe(0);
    const context: string = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain('tsc (root)');
    expect(context).toContain('TS2322');
  });

  it('reports a root-level file that no typecheck covers instead of passing it', () => {
    const run = editIn('stray.ts');
    expect(run.status).toBe(0);
    const context: string = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain('stray.ts is not checked by any typecheck');
    expect(context).not.toContain('tsc (root)');
  });
});
