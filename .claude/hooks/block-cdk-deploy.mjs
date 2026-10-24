#!/usr/bin/env node
// Claude Code PreToolUse hook (Bash). Denies any shell command that runs a CDK command which
// changes an AWS account — deploy, watch (continuous hotswap deploys), import, bootstrap,
// destroy, rollback, gc, refactor — directly. The brief's rule — deploy only after the whole
// local suite is green — is enforced here mechanically: the only sanctioned paths are
// `pnpm deploy:dev` (which runs `pnpm test` first) and the CI pipeline (`prod`, with manual
// approval). The one-time `cdk bootstrap` (WP0.10) is run by the developer, not by Claude.
// See docs/architecture.md §11.4.
//
// Deny by default, order-free, no exemptions (rule in ./lib/cdk-gate.mjs): a command whose text
// names the CDK CLI and such a subcommand anywhere is denied, even as a mere mention. Text that
// must mention such a command goes through a file (`git commit -F`, `gh pr create --body-file`).
// Fails closed: the rule module is loaded inside the guard, and unparseable input, input without a
// command string, or any error denies; .claude/settings.json also sets `onFailure: "block"` and
// lists the common spellings under `permissions.deny`. A guard against accidents, not an
// adversary: commands that run repo-defined code (package scripts, compose files, the CDK app) are
// out of reach of any text check; IAM and keeping AWS credentials out of the default shell are
// the real boundary (TODOS.md, WP0.10).
import { readFileSync } from 'node:fs';

const REASON =
  'Direct CDK commands that change an AWS account (deploy, watch, import, bootstrap, destroy, rollback, gc, refactor) are blocked, including mentions in the command text. Use `pnpm deploy:dev`, which runs the full local suite first and stops when anything is red; `prod` deploys only through the pipeline; the one-time bootstrap is run by the developer. To mention such a command in a commit or PR, write the text to a file and use `git commit -F` / `--body-file` (docs/architecture.md §11.4).';

try {
  const { runsMutatingCdk } = await import('./lib/cdk-gate.mjs');
  let command;
  try {
    command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command;
  } catch {
    deny(
      'Hook input could not be parsed, so the command was blocked (the deploy gate fails closed).',
    );
  }
  if (typeof command !== 'string') {
    deny('Hook input carried no command string, so the call was blocked (the gate fails closed).');
  }
  if (runsMutatingCdk(command)) deny(REASON);
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
