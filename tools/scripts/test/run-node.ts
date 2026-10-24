import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Absolute path of a file relative to the repository root. */
export function repoPath(relative: string): string {
  return fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
}

export interface NodeRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a Node script the way Claude Code runs a hook: JSON on stdin, decision on stdout. */
export function runNode(
  script: string,
  options: { args?: string[]; stdin?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): NodeRun {
  const result = spawnSync(process.execPath, [script, ...(options.args ?? [])], {
    input: options.stdin ?? '',
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
