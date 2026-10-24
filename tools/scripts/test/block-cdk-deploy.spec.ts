import { describe, expect, it } from 'vitest';
import { repoPath, runNode } from './run-node';

const HOOK = repoPath('.claude/hooks/block-cdk-deploy.mjs');

/** The hook's verdict for one Bash command: 'deny', or 'allow' when it prints nothing. */
function verdict(command: string): string {
  return decide(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));
}

function decide(stdin: string): string {
  const run = runNode(HOOK, { stdin });
  expect(run.status).toBe(0);
  if (run.stdout.trim() === '') return 'allow';
  return JSON.parse(run.stdout).hookSpecificOutput.permissionDecision;
}

describe('Deploy gate — direct CDK deploys are blocked (architecture §11.4)', () => {
  it.each([
    'cdk deploy',
    'npx cdk deploy --context stage=dev',
    'cdk --profile dev deploy App',
    'pnpm -F @fisio/infra exec cdk deploy',
    'cd infra && cdk deploy --all',
  ])('denies `%s`', (command) => {
    expect(verdict(command)).toBe('deny');
  });

  it.each([
    ['a double-quoted subcommand', 'cdk "deploy"'],
    ['a single-quoted subcommand', "npx cdk 'deploy' --all"],
    ['a backslash-escaped subcommand', 'cdk \\deploy'],
    ['a split quoted subcommand', "cdk dep''loy"],
    ['a version-pinned CLI', 'npx cdk@2 deploy'],
    ['the aws-cdk package name', 'npx aws-cdk@latest deploy'],
    ['the CLI by path', './node_modules/.bin/cdk deploy'],
    ['a deploy on the next line', 'cdk synth\ncdk deploy'],
  ])('denies %s, which the shell runs as a deploy', (_label, command) => {
    expect(verdict(command)).toBe('deny');
  });

  it('explains the sanctioned path in the denial reason', () => {
    const run = runNode(HOOK, {
      stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cdk deploy' } }),
    });
    const output = JSON.parse(run.stdout).hookSpecificOutput;
    expect(output.hookEventName).toBe('PreToolUse');
    expect(output.permissionDecisionReason).toContain('pnpm deploy:dev');
  });

  it.each([
    'pnpm deploy:dev',
    'cdk synth',
    'cdk diff --context stage=dev',
    'cdk synth && echo deploy',
    'cdk synth\necho deploy',
    'cat .claude/hooks/block-cdk-deploy.mjs',
    'ls -la',
  ])('allows `%s`', (command) => {
    expect(verdict(command)).toBe('allow');
  });

  it('fails closed: denies the call when the hook input is not valid JSON', () => {
    expect(decide('not json')).toBe('deny');
  });

  it('allows a tool call that carries no command', () => {
    expect(decide(JSON.stringify({ tool_name: 'Bash', tool_input: {} }))).toBe('allow');
  });
});
