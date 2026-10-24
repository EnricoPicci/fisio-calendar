#!/usr/bin/env node
// Claude Code PreToolUse hook (Bash). Denies any shell command that runs a CDK command which
// changes an AWS account — deploy, watch (continuous hotswap deploys), import, bootstrap,
// destroy, rollback — directly. The brief's rule — deploy only after the whole local suite is
// green — is enforced here mechanically: the only sanctioned paths are `pnpm deploy:dev` (which
// runs `pnpm test` first) and the CI pipeline (`prod`, with manual approval). The one-time
// `cdk bootstrap` (WP0.10) is run by the developer, not by Claude. See docs/architecture.md §11.4.
//
// Deny by default. The whole command line, with quotes and escapes removed, is scanned: if any
// command segment names the CDK CLI followed by an account-changing subcommand, the call is
// denied — however it is wrapped (`bash -lc '…'`, `"$(…)"`, `npx -c`, `node -e`, heredocs fed to a
// shell, redirections, odd quoting or case). Only text that is provably data is exempt first:
//   - a fully quoted argument of a message flag (`git commit -m '…'`, `gh pr create --body "…"`,
//     `--title`, `--message`) or of a grep/rg search, unless it is double-quoted and contains a
//     command substitution;
//   - the body of a heredoc fed to `cat`, `tee`, `git`, `gh` or `glab`, unless that line pipes on.
// False positives (a mention outside those exemptions) are the accepted cost of failing closed.
//
// Fails closed: unparseable input or any error inside this hook denies; .claude/settings.json
// also sets `onFailure: "block"` and lists the common spellings under `permissions.deny`.
// A guard against accidents, not an adversary: variable indirection (`X=deploy; cdk $X`) and
// package scripts that wrap the CLI are out of reach of a text check; IAM is the real boundary.
import { readFileSync } from 'node:fs';

const MUTATING = new Set(['deploy', 'watch', 'import', 'bootstrap', 'destroy', 'rollback']);
const CDK_CLI = /(?:^|\/)(?:aws-)?cdk(?:@\S*)?$/;
const MESSAGE_FLAGS = new Set(['-m', '--message', '--body', '--title', '-t']);
const SEARCH_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg']);
const HEREDOC_SINKS = new Set(['cat', 'tee', 'git', 'gh', 'glab']);
const REASON =
  'Direct CDK commands that change an AWS account (deploy, watch, import, bootstrap, destroy, rollback) are blocked. Use `pnpm deploy:dev`, which runs the full local suite first and stops when anything is red; `prod` deploys only through the pipeline; the one-time bootstrap is run by the developer (docs/architecture.md §11.4).';

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

function runsMutatingCdk(text) {
  const data = withoutMessageArguments(withoutHeredocData(text));
  // Two conservative readings, deny if either matches: separators taken literally everywhere,
  // and separators inside quotes treated as plain characters (`cdk -c "a=b;c" deploy`).
  return scan(data) || scan(quotedSeparatorsAsSpaces(data));
}

/** Replaces command separators that sit inside quotes with spaces (substitutions are kept). */
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

/** Conservative scan: quotes and escapes removed, every segment checked. */
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

/** Removes heredoc bodies that a data sink reads (and that do not pipe on to a command). */
function withoutHeredocData(text) {
  const opener = /<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1/g;
  let result = '';
  let from = 0;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    if (match.index < from) continue;
    const lineEnd = text.indexOf('\n', match.index);
    if (lineEnd === -1) break;
    const delimiter = match[2];
    const close = new RegExp(`^\\t*${delimiter}[ \\t]*$`, 'm');
    close.lastIndex = 0;
    const rest = text.slice(lineEnd + 1);
    const end = rest.search(close);
    if (end === -1) continue; // unterminated: keep it scanned
    const lineStart = Math.max(
      ...['\n', ';', '&', '|', '(', '`'].map((c) => text.lastIndexOf(c, match.index - 1)),
    );
    const head =
      text
        .slice(lineStart + 1, match.index)
        .trim()
        .split(/\s+/)[0] ?? '';
    const sink = HEREDOC_SINKS.has(head.replace(/["'\\]/g, ''));
    const pipesOn = text.slice(match.index, lineEnd).includes('|');
    if (sink && !pipesOn) {
      result += text.slice(from, lineEnd + 1);
      from = lineEnd + 1 + end; // keep the delimiter line, drop the body
    }
  }
  return result + text.slice(from);
}

/** Blanks fully quoted message and search arguments, which are data, not commands. */
function withoutMessageArguments(text) {
  const ranges = [];
  let words = [];
  let word = null;
  const startWord = (i) => {
    if (!word) word = { start: i, text: '', quotedFrom: -1, fullyQuoted: false, risky: false };
  };
  const endWord = (i) => {
    if (word) words.push({ ...word, end: i });
    word = null;
  };
  const endCommand = (i) => {
    endWord(i);
    markExempt(words, ranges);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || (c === '$' && text[i + 1] === "'")) {
      startWord(i);
      const begin = c === '$' ? i + 1 : i;
      const quote = text[begin];
      let j = begin + 1;
      let content = '';
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\' && quote !== "'") j++;
        else if (text[j] === '\\' && c === '$') j++;
        if (quote === '"' && (text[j] === '`' || (text[j] === '$' && text[j + 1] === '(')))
          word.risky = true;
        content += text[j] ?? '';
        j++;
      }
      if (j >= text.length) {
        word.risky = true; // unterminated quote: never exempt
        i = text.length;
        endCommand(i);
        break;
      }
      if (word.text === '' || /^--?[a-z]+=$/i.test(word.text)) {
        word.quotedFrom = word.text.length;
        word.fullyQuoted = text[j + 1] === undefined || /[\s;&|()`<>]/.test(text[j + 1]);
      } else {
        word.fullyQuoted = false;
      }
      word.text += content;
      i = j;
    } else if (c === '\\') {
      startWord(i);
      word.text += text[i + 1] ?? '';
      word.fullyQuoted = false;
      i++;
    } else if (';&|()`\n'.includes(c) || (c === '$' && text[i + 1] === '(')) {
      endCommand(i);
    } else if (/\s/.test(c)) {
      endWord(i);
    } else {
      startWord(i);
      word.text += c;
      if (word.quotedFrom !== -1) word.fullyQuoted = false;
    }
  }
  endCommand(text.length);
  if (ranges.length === 0) return text;
  let out = '';
  let from = 0;
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    out += `${text.slice(from, start)}''`;
    from = end;
  }
  return out + text.slice(from);
}

function markExempt(words, ranges) {
  const first = words[0]?.text ?? '';
  const isSearch = SEARCH_COMMANDS.has(first) || (first === 'git' && words[1]?.text === 'grep');
  words.forEach((word, i) => {
    if (!word.fullyQuoted || word.risky) return;
    const flagPrefix = word.text.slice(0, word.quotedFrom);
    const previous = words[i - 1]?.text ?? '';
    const isMessage =
      MESSAGE_FLAGS.has(previous) || MESSAGE_FLAGS.has(flagPrefix.replace(/=$/, ''));
    if (isMessage || isSearch) ranges.push([word.start, word.end]);
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
