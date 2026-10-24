#!/usr/bin/env node
// Claude Code PreToolUse hook (Bash). Denies any shell command that runs `cdk deploy` directly.
// The brief's rule — deploy only after the whole local suite is green — is enforced here
// mechanically: the only sanctioned paths are `pnpm deploy:dev` (which runs `pnpm test` first)
// and the CI pipeline (`prod`, with manual approval). See docs/architecture.md §11.4.
import { readFileSync } from 'node:fs';

let command = '';
try {
  command = String(JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '');
} catch {
  process.exit(0);
}

// `cdk … deploy` as whitespace-separated tokens within one shell segment: covers `cdk deploy`,
// `npx cdk deploy`, `cdk --profile x deploy`, `pnpm -F @fisio/infra exec cdk deploy`.
// Not matched: `pnpm deploy:dev`, `cdk synth && echo deploy`, this file's own name.
const DIRECT_CDK_DEPLOY = /\bcdk\s+(?:[^\s|&;]+\s+)*?deploy\b/;

if (DIRECT_CDK_DEPLOY.test(command)) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Direct `cdk deploy` is blocked. Use `pnpm deploy:dev`, which runs the full local suite first and stops when anything is red; `prod` deploys only through the pipeline (docs/architecture.md §11.4).',
      },
    }),
  );
}
