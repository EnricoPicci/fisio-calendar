#!/usr/bin/env node
// Claude Code PreToolUse hook (Bash). Denies any shell command that runs a CDK command which
// changes an AWS account — deploy, watch (continuous hotswap deploys), import, bootstrap,
// destroy, rollback — directly. The brief's rule — deploy only after the whole local suite is
// green — is enforced here mechanically: the only sanctioned paths are `pnpm deploy:dev` (which
// runs `pnpm test` first) and the CI pipeline (`prod`, with manual approval). The one-time
// `cdk bootstrap` (WP0.10) is run by the developer, not by Claude. See docs/architecture.md §11.4.
//
// Fails closed: input that cannot be parsed, and any error inside this hook, deny the command;
// .claude/settings.json also sets `onFailure: "block"`, so a crash or timeout blocks it too, and
// lists the common spellings under `permissions.deny` as a node-free second layer.
// The command line is read the way a shell reads it: quotes group words (a quoted commit message
// or grep pattern is one word, not a command), separators and redirections outside quotes split
// commands and words, and the text given to `sh -c`, `bash -c` or `eval` is checked as a command.
// A guard against accidents, not an adversary: variable indirection (`X=deploy; cdk $X`) and
// package scripts that wrap the CLI are out of reach of a text check; IAM is the real boundary.
import { readFileSync } from 'node:fs';

const MUTATING = new Set(['deploy', 'watch', 'import', 'bootstrap', 'destroy', 'rollback']);
const CDK_CLI = /(?:^|\/)(?:aws-)?cdk(?:@\S*)?$/;
const SHELLS = /(?:^|\/)(?:sh|bash|zsh|dash|ksh)$/;
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
  if (typeof command === 'string' && runsMutatingCdk(command, 0)) deny(REASON);
} catch (error) {
  deny(`The deploy gate failed (${error?.message ?? error}), so the command was blocked.`);
}

/** True when any simple command in `text` is the CDK CLI followed by a mutating subcommand. */
function runsMutatingCdk(text, depth) {
  if (depth > 3) return true; // absurd nesting: fail closed
  return splitCommands(text).some((words) => {
    const cli = words.findIndex((word) => CDK_CLI.test(word));
    if (cli !== -1 && words.slice(cli + 1).some((word) => MUTATING.has(word))) return true;
    // Text handed to a shell or to eval is itself a command line.
    return words.some((word, i) => {
      const previous = words[i - 1];
      const isScript =
        previous === 'eval' ||
        (previous === '-c' && words.slice(0, i - 1).some((w) => SHELLS.test(w)));
      return isScript && runsMutatingCdk(word, depth + 1);
    });
  });
}

/**
 * Splits a command line into simple commands, each a list of unquoted words. Quotes ('…', "…",
 * $'…') group characters into one word; a backslash escapes the next character; outside quotes,
 * `;` `&` `|` `(` `)` `` ` `` and newlines end a command, `$(` starts one, whitespace ends a word
 * and redirections (`<`, `>`, `2>&1`, …) end a word and are dropped.
 */
function splitCommands(text) {
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === '\n') {
        i++;
        continue;
      }
      word += text[i + 1] ?? '';
      inWord = true;
      i++;
    } else if (c === "'" || (c === '$' && text[i + 1] === "'")) {
      if (c === '$') i++;
      const end = text.indexOf("'", i + 1);
      const close = end === -1 ? text.length : end;
      word += text.slice(i + 1, close);
      inWord = true;
      i = close;
    } else if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) i++;
        word += text[i];
        i++;
      }
      inWord = true;
    } else if (c === '$' && text[i + 1] === '(') {
      endCommand();
      i++;
    } else if (';&|()`\n'.includes(c)) {
      endCommand();
    } else if (c === '<' || c === '>') {
      // A redirection: `2>` keeps no digits in the word, `>&1` / `<&0` skip the descriptor.
      if (/^\d+$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      while (text[i + 1] === '>' || text[i + 1] === '<') i++;
      if (text[i + 1] === '&') {
        i++;
        while (/\d|-/.test(text[i + 1] ?? '')) i++;
      }
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
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
