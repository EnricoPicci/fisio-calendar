// The deploy-gate rule, shared by the PreToolUse Bash hook (block-cdk-deploy.mjs) and the
// PostToolUse edit hook (on-ts-edit.mjs).
//
// Order-free and segment-free, with no exemptions: the text matches when it contains, anywhere,
// both a word naming the CDK CLI and a word naming an account-changing subcommand. Shell
// structure is deliberately not reconstructed — every attempt to (quotes, segments, heredocs,
// message flags) was bypassed in review — so `cdk $(true) deploy`, `echo deploy | xargs cdk`,
// `{cdk,deploy}` or a subcommand in another line all match. Before matching, the text is
// normalised the way a shell would spell it: lower case, ANSI-C `$'…'` escapes decoded,
// `${x:-word}` defaults and `$IFS` expanded, quotes and backslashes removed; a word with glob
// characters counts as the CLI when the glob could match it. A false positive (a mere mention)
// is the accepted cost; such text goes through a file (`git commit -F`, `--body-file`).
// See docs/tooling-and-skills.md §2.3.

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
const CDK_CLI = /(?:^|\/)(?:aws-)?cdk(?:\.js|\.cmd|\.ps1)?(?:@\S*)?$/;

/** True when `text` names the CDK CLI and an account-changing subcommand anywhere. */
export function runsMutatingCdk(text) {
  if (typeof text !== 'string') return false;
  const words = normalise(text).split(/\s+/).filter(Boolean);
  return words.some(isCdkCli) && words.some((word) => MUTATING.has(word));
}

function normalise(text) {
  return decodeAnsiC(text)
    .toLowerCase()
    .replace(/\$\{?ifs\}?/g, ' ')
    .replace(/\$\{[^}]*?:?[-=+?]([^}]*)\}/g, ' $1 ')
    .replace(/\$\{[^}]*\}/g, ' ')
    .replace(/["'\\]/g, '')
    .replace(/[^a-z0-9@._/:?*[\]-]+/g, ' ');
}

function isCdkCli(word) {
  if (CDK_CLI.test(word) || word.includes('/aws-cdk/')) return true;
  if (!/[?*[]/.test(word)) return false;
  // A glob such as `c?k`, `cd[k]` or `.bin/*` could expand to the CLI.
  const last = word.split('/').pop() ?? '';
  const pattern = last
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\?/g, '.')
    .replace(/\*/g, '.*');
  try {
    const glob = new RegExp(`^${pattern}$`);
    return ['cdk', 'aws-cdk', 'cdk.js'].some((name) => glob.test(name));
  } catch {
    return true; // an unparseable bracket expression: assume it could match
  }
}

/** Replaces each `$'…'` with the characters bash would produce from its escapes. */
function decodeAnsiC(text) {
  return text.replace(/\$'((?:\\.|[^'\\])*)'/g, (_match, body) =>
    body.replace(
      /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/g,
      (_escape, code) => {
        const kind = code[0];
        if (kind === 'x' || kind === 'u' || kind === 'U') {
          return String.fromCodePoint(Number.parseInt(code.slice(1), 16));
        }
        if (/[0-7]/.test(kind)) return String.fromCodePoint(Number.parseInt(code, 8));
        if (kind === 'c') return String.fromCharCode(code.charCodeAt(1) & 31);
        return (
          { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' }[kind] ??
          kind
        );
      },
    ),
  );
}
