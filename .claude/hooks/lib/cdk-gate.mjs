// The deploy-gate rule, shared by the PreToolUse Bash hook (block-cdk-deploy.mjs) and the
// PostToolUse edit hook (on-ts-edit.mjs, which refuses package scripts that match it).
//
// Deny by default, no exemptions: the whole text is scanned with quotes and escapes removed
// (and a second time with separators inside quotes neutralised), and it matches when any command
// segment names the CDK CLI followed by an account-changing subcommand — however it is wrapped
// or quoted, inside messages, heredocs, comments or substitutions alike. Text that must mention
// such a command (a commit message, a PR body) goes through a file: `git commit -F <file>`,
// `gh pr create --body-file <file>`. See docs/tooling-and-skills.md §2.3.

const MUTATING = new Set([
  'deploy',
  'watch',
  'import',
  'bootstrap',
  'destroy',
  'rollback',
  'gc',
  'refactor',
]);
const CDK_CLI = /(?:^|\/)(?:aws-)?cdk(?:@\S*)?$/;

/** True when `text` names the CDK CLI followed by an account-changing subcommand. */
export function runsMutatingCdk(text) {
  return scan(text) || scan(quotedSeparatorsAsSpaces(text));
}

function scan(text) {
  const flat = text
    .toLowerCase()
    .replace(/\\\n/g, ' ')
    .replace(/\$(?=['"])/g, '')
    .replace(/["'\\]/g, '')
    .replace(/>\|/g, ' ')
    .replace(/&>>?/g, ' ')
    .replace(/[<>]+(?:&-?\d*)?/g, ' ');
  return flat.split(/\$\(|[;&|()`\n]/).some((segment) => {
    const words = segment.trim().split(/\s+/);
    const cli = words.findIndex((word) => CDK_CLI.test(word));
    return cli !== -1 && words.slice(cli + 1).some((word) => MUTATING.has(word));
  });
}

/** Replaces command separators that sit inside quotes with spaces (`cdk -c "a=b;c" deploy`). */
function quotedSeparatorsAsSpaces(text) {
  let out = '';
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote !== "'" && i + 1 < text.length) {
        out += c + text[++i];
        continue;
      }
      if (c === quote) quote = '';
      else if (quote === "'" ? ';&|()`\n'.includes(c) : ';&|\n'.includes(c)) {
        out += ' ';
        continue;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
    }
    out += c;
  }
  return out;
}
