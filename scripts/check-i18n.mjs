/**
 * Checks that every message the code shows can be shown in Chinese.
 *
 * The English text is the key into the catalog, which is what makes the extension readable at the call
 * site - and what makes a missing translation silent. Nothing fails, nothing is logged; the user in that
 * language simply gets English in the middle of a translated dialog, and the only person who can see it is
 * somebody who reads that language. `check-docs.mjs` can cover the manifest because `package.json` names
 * its keys, but the messages in code have no such list. This builds one.
 *
 * Two things are compared, and only one of them is an error:
 *
 * - a message shown to a user that has no catalog entry - a real gap, so the build fails;
 * - a catalog entry nothing appears to use - often just a key that is used from somewhere this cannot
 *   read, so it is reported and not failed on.
 *
 * Runs as part of `npm test`. Exits non-zero and prints every problem it found.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZH_CN } from '../src/util/messages.zh-cn.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Calls this script cannot resolve to a key, and why they are fine.
 *
 * Keyed by file, with the exact text that is allowed and the catalog keys it may produce. Listing those
 * keys is what keeps them from being reported as unused, and they are verified like any other key - so a
 * renamed choice label is still a failure, just a quieter one. Anything not listed here fails: a message
 * built at runtime is a message this cannot check, and silence about it is how the gap reappears.
 */
const ALLOWED_INDIRECT = new Map([
  [
    'src/service/ExportService.ts',
    [
      {
        // The label of a separator the user picked, from the table a few lines above. Translated at the
        // call site rather than in the table, because a table is built before the locale is known.
        snippet: 't(entry.label)',
        keys: ['Comma', 'Semicolon', 'Tab', 'Pipe'],
      },
    ],
  ],
]);

/** The escapes that appear in a message, JS-style. */
const ESCAPES = new Map([
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['\\', '\\'],
  ["'", "'"],
  ['"', '"'],
]);

/** Every `.ts` file under the given directories, tests included. */
function sourceFiles(...directories) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'out') {
          walk(path);
        }
      } else if (entry.name.endsWith('.ts')) {
        found.push(path);
      }
    }
  };
  for (const directory of directories) {
    walk(directory);
  }
  return found;
}

/**
 * The same source with comments and string bodies blanked out.
 *
 * Blanked rather than removed so that offsets, and therefore line numbers, do not move. A `t('...')`
 * written inside a doc comment - which this file's own explanation of the mechanism does - is not a
 * message, and reporting it as one would make the check wrong in a way nobody would trust twice.
 */
function withoutComments(text) {
  const blank = (from, to) => text.slice(from, to).replace(/[^\n]/g, ' ');
  let result = '';
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      const stop = end === -1 ? text.length : end;
      result += blank(index, stop);
      index = stop;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      result += blank(index, stop);
      index = stop;
      continue;
    }
    result += text[index];
    index++;
  }
  return result;
}

/**
 * The literal argument of a `t(...)` call, starting at the opening quote.
 *
 * Adjacent literals joined by `+` are concatenated, because that is how a long message is written when it
 * does not fit on one line. Anything else - a variable, a call, a template literal - returns undefined and
 * is reported instead, rather than guessed at.
 */
function readArgument(text, start) {
  let index = start;
  let value = '';
  let literals = 0;
  for (;;) {
    while (/\s/.test(text[index] ?? '')) {
      index++;
    }
    const quote = text[index];
    if (quote !== "'" && quote !== '"') {
      return undefined;
    }
    index++;
    let closed = false;
    while (index < text.length) {
      const character = text[index];
      if (character === '\\') {
        // Decoded the way JavaScript decodes it, because the catalog was decoded too: comparing `\n` as
        // the letter `n` reports a message that is right there as missing.
        const escaped = text[index + 1] ?? '';
        value += ESCAPES.get(escaped) ?? escaped;
        index += 2;
        continue;
      }
      if (character === quote) {
        index++;
        closed = true;
        break;
      }
      // A real newline inside a '"' literal is not how any of these are written.
      value += character;
      index++;
    }
    if (!closed) {
      return undefined;
    }
    literals++;
    while (/\s/.test(text[index] ?? '')) {
      index++;
    }
    if (text[index] !== '+') {
      break;
    }
    index++;
  }
  // A literal that is not followed by the end of the argument is not the whole message.
  const next = text[index];
  return literals > 0 && (next === ')' || next === ',') ? value : undefined;
}

const used = new Map();
const indirect = [];
const files = sourceFiles('src', 'media');

for (const file of files) {
  const text = withoutComments(readFileSync(join(root, file), 'utf8'));
  const lines = text.split('\n');
  const lineOf = (offset) => {
    let seen = 0;
    for (let index = 0; index < lines.length; index++) {
      seen += lines[index].length + 1;
      if (seen > offset) {
        return index + 1;
      }
    }
    return lines.length;
  };

  // `(?<![\w.$])` keeps `format(` and `something.t(` out of this: a word boundary alone would let both in.
  for (const match of text.matchAll(/(?<![\w.$])t\(/g)) {
    // `export function t(` is the definition, not a message.
    if (/\bfunction\s+$/.test(text.slice(Math.max(0, match.index - 20), match.index))) {
      continue;
    }
    const argument = readArgument(text, match.index + 2);
    if (argument === undefined) {
      const line = lineOf(match.index);
      indirect.push({ file, line, snippet: lines[line - 1].trim() });
      continue;
    }
    if (!used.has(argument)) {
      used.set(argument, `${file}:${lineOf(match.index)}`);
    }
  }

  // The keys a whitelisted indirect call may produce count as used, so that a table of labels does not
  // read as four dead translations.
  for (const { snippet, keys } of ALLOWED_INDIRECT.get(file) ?? []) {
    if (text.includes(snippet)) {
      for (const key of keys) {
        used.set(key, file);
      }
    }
  }
}

const problems = [];
const check = (message) => console.log(`  ok  ${message}`);
const fail = (message) => {
  problems.push(message);
  console.log(`  FAIL ${message}`);
};

const isTest = (file) => file.endsWith('.test.ts');
const shown = [...used].filter(([, where]) => !isTest(where.split(':')[0]));
const missing = shown.filter(([key]) => !(key in ZH_CN));

if (missing.length > 0) {
  for (const [key, where] of missing) {
    fail(`${where}: no Chinese text for ${JSON.stringify(key)}`);
  }
} else {
  check(`${shown.length} message(s) shown to users are translated`);
}

const unexpected = indirect.filter(({ file, snippet }) => {
  const allowed = ALLOWED_INDIRECT.get(file) ?? [];
  return !allowed.some((entry) => snippet.includes(entry.snippet));
});
if (unexpected.length > 0) {
  for (const { file, line, snippet } of unexpected) {
    fail(`${file}:${line}: the message is computed, so it cannot be checked: ${snippet}`);
  }
} else {
  check('every message is a literal, or one of the known indirect calls');
}

const unused = Object.keys(ZH_CN).filter((key) => !used.has(key));
if (unused.length > 0) {
  // Not a failure: a key may be reached from a call this cannot read, and deleting a translation someone
  // added on purpose is worse than carrying an unused line.
  console.log(`  warn  ${unused.length} catalog entry(ies) nothing seems to use:`);
  for (const key of unused.slice(0, 10)) {
    console.log(`        ${JSON.stringify(key)}`);
  }
  if (unused.length > 10) {
    console.log(`        ... and ${unused.length - 10} more`);
  }
} else {
  check('every catalog entry is used');
}

if (problems.length > 0) {
  console.log(`\n[i18n] ${problems.length} problem(s) found`);
  process.exit(1);
}
console.log('\n[i18n] every message shown to a user has a translation');
