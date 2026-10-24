#!/usr/bin/env node
// Claude Code PreToolUse hook (Bash). Denies any shell command that runs a CDK deploy directly.
// The brief's rule — deploy only after the whole local suite is green — is enforced here
// mechanically: the only sanctioned paths are `pnpm deploy:dev` (which runs `pnpm test` first)
// and the CI pipeline (`prod`, with manual approval). See docs/architecture.md §11.4.
//
// Fails closed: input that cannot be parsed is denied, and .claude/settings.json sets
// `onFailure: "block"` so a crash or timeout of this hook also blocks the command. The
// `permissions.deny` rules there are a second, node-free layer for the common spellings.
// A guard against accidents, not an adversary: variable indirection (`X=deploy; cdk $X`) is
// out of reach of a text check, and IAM remains the real boundary.
import { readFileSync } from 'node:fs';

const REASON =
  'Direct CDK deploys are blocked. Use `pnpm deploy:dev`, which runs the full local suite first and stops when anything is red; `prod` deploys only through the pipeline (docs/architecture.md §11.4).';

let command;
try {
  command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command;
} catch {
  deny(
    'Hook input could not be parsed, so the command was blocked (the deploy gate fails closed).',
  );
}

if (typeof command === 'string' && runsCdkDeploy(command)) deny(REASON);

/**
 * True when, within one shell segment, a token naming the CDK CLI (`cdk`, `cdk@2`, `aws-cdk`,
 * `aws-cdk@latest`, `node_modules/.bin/cdk`) is followed by a `deploy` token. Quotes and
 * backslashes are removed first, as the shell would remove them: `cdk "deploy"` is a deploy.
 */
export function runsCdkDeploy(text) {
  const unquoted = text.replace(/\\\n/g, ' ').replace(/["'\\]/g, '');
  const segments = unquoted.split(/&&|\|\||[;&|\n()`]|\$\(/);
  return segments.some((segment) => {
    const tokens = segment.trim().split(/\s+/);
    const cli = tokens.findIndex((token) => /(?:^|\/)(?:aws-)?cdk(?:@\S*)?$/.test(token));
    return cli !== -1 && tokens.slice(cli + 1).includes('deploy');
  });
}

function deny(reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}
