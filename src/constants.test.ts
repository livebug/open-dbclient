/**
 * Tests for the `-- @connection` directive.
 *
 * Written after a bug where the extension *wrote* `-- @connection: name` but only *read*
 * `-- @connection name`. Nothing failed loudly: the binding silently did not resolve, so every run
 * prompted for a connection, and each answer appended another copy of the directive to the file.
 *
 * Run with: node --test src/constants.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTION_DIRECTIVE, connectionDirective } from './constants.ts';

const nameOf = (sql: string): string | undefined => CONNECTION_DIRECTIVE.exec(sql)?.[1];

const withDirective = (line: string): string => `${line}\n\nSELECT 1;\n`;

test('the form the extension writes is read back', () => {
  assert.equal(nameOf(withDirective('-- @connection: production')), 'production');
});

test('the form people type by hand is read back', () => {
  assert.equal(nameOf(withDirective('-- @connection production')), 'production');
});

test('no space after the dashes still works', () => {
  assert.equal(nameOf(withDirective('--@connection production')), 'production');
});

test('spacing around the colon is tolerated', () => {
  assert.equal(nameOf(withDirective('--   @connection  :   production')), 'production');
});

test('leading indentation is tolerated', () => {
  assert.equal(nameOf(withDirective('    -- @connection production')), 'production');
});

test('a name containing spaces is kept whole', () => {
  assert.equal(nameOf(withDirective('-- @connection staging read only')), 'staging read only');
});

test('a name with non-ascii characters survives', () => {
  assert.equal(nameOf(withDirective('-- @connection 生产库只读')), '生产库只读');
});

test('the directive may appear anywhere in the file', () => {
  const sql = 'SELECT 1;\n\n-- @connection: analytics\n\nSELECT 2;\n';
  assert.equal(nameOf(sql), 'analytics');
});

test('the first directive wins when several are present', () => {
  const sql = '-- @connection: first\n-- @connection: second\n';
  assert.equal(nameOf(sql), 'first');
});

test('the directive is anchored to its own line', () => {
  // Mid-statement text that merely mentions the word must not be mistaken for a directive.
  assert.equal(nameOf('SELECT 1; -- @connection production trailing\n'), undefined);
});

test('a bare @connection with no name is not a directive', () => {
  assert.equal(nameOf('-- @connection\n'), undefined);
  assert.equal(nameOf('-- @connection:\n'), undefined);
  assert.equal(nameOf('-- @connection   \n'), undefined);
});

test('a trailing comment after the name belongs to the name', () => {
  // Documented rather than ideal: the directive runs to the end of the line, so a trailing comment is
  // part of it. Names with comments are not a supported spelling.
  assert.equal(nameOf(withDirective('-- @connection production -- for reports')), 'production -- for reports');
});

test('the replacement range covers the whole directive line', () => {
  const sql = '-- @connection: old\n\nSELECT 1;\n';
  const match = CONNECTION_DIRECTIVE.exec(sql);
  assert.ok(match);
  assert.equal(match.index, 0);
  assert.equal(sql.slice(0, match[0].length), '-- @connection: old');
});

test('rewriting a directive is idempotent, so binding cannot pile up copies', () => {
  // This is the regression that mattered: bind() replaces when the regex matches and inserts when it
  // does not. A regex that failed to see the written form inserted a new line on every run.
  let sql = 'SELECT 1;\n';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const match = CONNECTION_DIRECTIVE.exec(sql);
    sql = match
      ? sql.slice(0, match.index) + '-- @connection: production' + sql.slice(match.index + match[0].length)
      : `-- @connection: production\n${sql}`;
  }
  assert.equal(sql, '-- @connection: production\nSELECT 1;\n');
  assert.equal(sql.split('@connection').length - 1, 1, 'only one directive should remain');
});

test('every name the writer can produce is readable by the pattern', () => {
  // The invariant that was violated: writing and reading used different spellings. Checked across
  // the shapes a real connection name takes rather than one example, because the failure mode is
  // silent - a name that fails to read back just prompts for a connection again.
  const names = [
    'production',
    'staging read only',
    '生产库只读',
    'with:colon',
    ':leading-colon',
    'trailing-colon:',
    'has-dash_and.underscore',
    'UPPER lower 123',
    'emoji 🙂 db',
  ];

  for (const name of names) {
    assert.equal(nameOf(`${connectionDirective(name)}\nSELECT 1;\n`), name, `round trip failed for ${JSON.stringify(name)}`);
  }
});

test('the writer collapses names that would otherwise span lines', () => {
  // A newline inside the name would make the directive unreadable, which is the same silent failure
  // as writing a spelling the pattern does not understand.
  assert.equal(nameOf(`${connectionDirective('two\nlines')}\nSELECT 1;\n`), 'two lines');
  assert.equal(nameOf(`${connectionDirective('tab\tseparated')}\nSELECT 1;\n`), 'tab separated');
  assert.equal(nameOf(`${connectionDirective('  padded  ')}\nSELECT 1;\n`), 'padded');
});
