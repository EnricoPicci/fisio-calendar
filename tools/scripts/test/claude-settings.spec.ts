import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath } from './run-node';

interface HookEntry {
  matcher: string;
  hooks: { type: string; command: string; onFailure?: string }[];
}

const settings = JSON.parse(readFileSync(repoPath('.claude/settings.json'), 'utf8')) as {
  permissions: { allow: string[]; ask: string[]; deny: string[] };
  hooks: Record<string, HookEntry[]>;
};

function hooksFor(event: string, matcher: string) {
  return (settings.hooks[event] ?? [])
    .filter((entry) => entry.matcher === matcher)
    .flatMap((entry) => entry.hooks);
}

describe('Claude Code project settings — the hooks stay wired (tooling doc §2.2, §2.3)', () => {
  it('runs the deploy gate before every Bash command', () => {
    const commands = hooksFor('PreToolUse', 'Bash').map((hook) => hook.command);
    expect(commands.join('\n')).toContain('block-cdk-deploy.mjs');
  });

  it('blocks the Bash command when the deploy gate itself fails (fail closed)', () => {
    const gate = hooksFor('PreToolUse', 'Bash').find((hook) =>
      hook.command.includes('block-cdk-deploy.mjs'),
    );
    expect(gate?.onFailure).toBe('block');
  });

  it('runs Biome and the typecheck after every Edit, Write or MultiEdit', () => {
    const commands = hooksFor('PostToolUse', 'Edit|Write|MultiEdit').map((hook) => hook.command);
    expect(commands.join('\n')).toContain('on-ts-edit.mjs');
  });
});

describe('Claude Code project settings — the permission lists', () => {
  it('denies the common direct-deploy spellings without depending on node', () => {
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(['Bash(cdk deploy*)', 'Bash(npx cdk deploy*)']),
    );
  });

  it('keeps deploys, pushes, recursive deletes and file-writing git flags on the ask list', () => {
    expect(settings.permissions.ask).toEqual(
      expect.arrayContaining([
        'Bash(pnpm deploy:*)',
        'Bash(git push*)',
        'Bash(rm -rf*)',
        'Bash(git diff*--output*)',
        'Bash(git log*--output*)',
      ]),
    );
  });

  it('never pre-approves a deploy', () => {
    expect(settings.permissions.allow.filter((rule) => /deploy/.test(rule))).toEqual([]);
  });

  it('pre-approves only exact commands or prefixes — no wildcard in the middle of a rule', () => {
    const midWildcard = settings.permissions.allow.filter((rule) => {
      const inner = rule.replace(/^Bash\((.*)\)$/, '$1');
      const star = inner.indexOf('*');
      return star !== -1 && star !== inner.length - 1;
    });
    expect(midWildcard).toEqual([]);
  });
});
