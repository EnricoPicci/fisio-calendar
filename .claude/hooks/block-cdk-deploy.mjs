#!/usr/bin/env node
// Claude Code PreToolUse hook (Bash). Denies any shell command that runs a CDK command which
// changes an AWS account — deploy, watch (continuous hotswap deploys), import, bootstrap,
// destroy, rollback, gc, refactor — directly. The brief's rule — deploy only after the whole
// local suite is green — is enforced here mechanically: the only sanctioned paths are
// `pnpm deploy:dev` (which runs `pnpm test` first) and the CI pipeline (`prod`, with manual
// approval). The one-time `cdk bootstrap` (WP0.10) is run by the developer, not by Claude.
// See docs/architecture.md §11.4.
//
// Deny by default with no exemptions (rule in ./lib/cdk-gate.mjs): any mention in the command
// text is denied, even in a commit message or a heredoc. Text that must mention such a command
// goes through a file (`git commit -F <file>`, `gh pr create --body-file <file>`).
// Fails closed: unparseable input or any error inside this hook denies; .claude/settings.json
// also sets `onFailure: "block"` and lists the common spellings under `permissions.deny`.
// A guard against accidents, not an adversary: variable indirection (`X=deploy; cdk $X`) and
// package scripts that wrap the CLI are out of reach of a text check; IAM is the real boundary.
import { readFileSync } from 'node:fs';
import { runsMutatingCdk } from './lib/cdk-gate.mjs';

const REASON =
  'Direct CDK commands that change an AWS account (deploy, watch, import, bootstrap, destroy, rollback, gc, refactor) are blocked, including mentions in the command text. Use `pnpm deploy:dev`, which runs the full local suite first and stops when anything is red; `prod` deploys only through the pipeline; the one-time bootstrap is run by the developer. To mention such a command in a commit or PR, write the text to a file and use `git commit -F` / `--body-file` (docs/architecture.md §11.4).';

try {
  let command;
  try {
    command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command;
  } catch {
    deny(
      'Hook input could not be parsed, so the command was blocked (the deploy gate fails closed).',
    );
  }
  if (typeof command === 'string' && runsMutatingCdk(command)) deny(REASON);
} catch (error) {
  deny(`The deploy gate failed (${error?.message ?? error}), so the command was blocked.`);
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
