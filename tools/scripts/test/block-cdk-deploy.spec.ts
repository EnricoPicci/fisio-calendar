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

describe('Deploy gate — direct CDK commands that change an AWS account are blocked (architecture §11.4)', () => {
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
    ['continuous hotswap deploys', 'cdk watch'],
    ['a stack import', 'npx cdk import App'],
    ['an account bootstrap', 'cdk bootstrap aws://123456789012/eu-central-1'],
    ['a stack teardown', 'cdk destroy --all --force'],
    ['a rollback', 'cdk rollback App'],
  ])('denies %s, which also changes the account', (_label, command) => {
    expect(verdict(command)).toBe('deny');
  });

  // Value: protects=spellings the shell runs as a deploy; fails_when=the scan stops failing closed for a wrapper, quote form, redirect or heredoc; why_new=bypasses found in review cycles 1-3; seam=none; no_claim=variable indirection
  it.each([
    ['a double-quoted subcommand', 'cdk "deploy"'],
    ['a single-quoted subcommand', "npx cdk 'deploy' --all"],
    ['an ANSI-C quoted subcommand', "cdk $'deploy'"],
    ['a backslash-escaped subcommand', 'cdk \\deploy'],
    ['a split quoted subcommand', "cdk dep''loy"],
    ['a version-pinned CLI', 'npx cdk@2 deploy'],
    ['the aws-cdk package name', 'npx aws-cdk@latest deploy'],
    ['the CLI by path', './node_modules/.bin/cdk deploy'],
    ['a deploy on the next line', 'cdk synth\ncdk deploy'],
    ['an output redirect glued to the subcommand', 'cdk deploy>out.log'],
    ['an input redirect glued to the subcommand', 'cdk deploy<in'],
    ['a redirect glued to the CLI', 'cdk>/dev/null deploy'],
    ['a separator inside a quoted argument', 'cdk -c "a=b;c" deploy'],
    ['a pipe inside a quoted profile', 'cdk --profile "p|q" deploy'],
    ['a command run through bash -c', 'bash -c "cdk deploy --all"'],
    ['a command run through eval', 'eval "cdk deploy"'],
    ['a command substitution', 'echo $(cdk deploy)'],
    ['a substitution inside double quotes', 'OUT="$(npx cdk deploy --require-approval never)"'],
    ['a backtick inside double quotes', 'echo "result: `npx cdk deploy`"'],
    ['a login shell with combined flags', "bash -lc 'npx cdk deploy'"],
    ['an interactive zsh', 'zsh -ic "cdk deploy"'],
    ['a shell with -c --', "sh -c -- 'cdk deploy'"],
    ['npx -c', "npx -c 'cdk deploy'"],
    ['npm exec -c', "npm exec -c 'cdk deploy'"],
    [
      'node -e running a child process',
      `node -e "require('child_process').execSync('npx cdk deploy')"`,
    ],
    ['an escaped quote inside ANSI-C quoting', "echo $'it\\'s' ; cdk deploy"],
    ['a both-streams redirect', 'cdk &>log deploy'],
    ['a clobber redirect', 'cdk >|out deploy'],
    ['an upper-case CLI name', 'npx CDK deploy'],
    ['a heredoc fed to a shell', "bash <<'EOF'\ncdk deploy\nEOF"],
    ['a heredoc piped on to a shell', "cat <<'EOF' | sh\ncdk deploy\nEOF"],
    [
      'a real command after a heredoc body with an apostrophe',
      "cat <<'EOF'\nit doesn't\nEOF\npnpm exec cdk deploy",
    ],
    ['a message argument that hides a substitution', 'git commit -m "$(cdk deploy)"'],
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

  // Value: protects=daily commands that only mention the CLI; fails_when=quoted text is read as a command again; why_new=cycle-2 red team false positives (commit -m, grep, gh --body); seam=none; no_claim=unquoted prose
  it.each([
    'pnpm deploy:dev',
    'cdk synth',
    'cdk diff --context stage=dev',
    'cdk synth && echo deploy',
    'cdk synth\necho deploy',
    'cdk synth 2>&1 | tee synth.log',
    'cat .claude/hooks/block-cdk-deploy.mjs',
    'git commit -m "docs: never run cdk deploy directly"',
    'grep -rn "cdk deploy" docs/',
    "gh pr create --body 'the gate blocks cdk deploy and cdk watch'",
    'ls -la',
    `git commit -m "$(cat <<'EOF'\nfix: never run cdk deploy directly\nEOF\n)"`,
    "gh pr create --title 'gate' --body-file - <<'EOF'\nNever run cdk deploy directly.\nEOF",
    "cat >> CHANGELOG.md <<'EOF'\n- the gate blocks cdk watch and cdk destroy\nEOF",
    'gh pr create --body="the gate blocks cdk deploy"',
    "rg -n 'cdk (deploy|watch)' docs",
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
