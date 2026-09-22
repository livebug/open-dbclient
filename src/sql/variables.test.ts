/**
 * Tests for SQL parameter substitution.
 *
 * Run with: node --test src/sql/variables.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_VARIABLE_PATTERN,
  compilePattern,
  substitute,
  variableNames,
} from './variables.ts';

const pattern = () => compilePattern(DEFAULT_VARIABLE_PATTERN);
const values = (entries: Record<string, string>) => new Map(Object.entries(entries));

test('finds names in the order they appear, once each', () => {
  const text = 'WHERE d = ${V_DATE} AND n = ${V_NAME} AND d2 = ${V_DATE}';
  assert.deepEqual(variableNames(text, pattern()), ['V_DATE', 'V_NAME']);
});

test('the default spelling covers spaces inside the braces and lower case', () => {
  assert.deepEqual(variableNames('a ${ spaced } b ${lower} c', pattern()), ['spaced', 'lower']);
});

test('a placeholder that is not a valid identifier is ignored', () => {
  assert.deepEqual(variableNames('${1BAD} ${} ${V_OK}', pattern()), ['V_OK']);
});

test('substitution replaces every occurrence', () => {
  const result = substitute('a=${X} b=${X}', pattern(), values({ X: '7' }));
  assert.equal(result.sql, 'a=7 b=7');
  assert.deepEqual(result.missing, []);
});

test('a value that is empty counts as missing, not as an empty string', () => {
  // Replacing with '' would turn `> ${V_DATE}` into `> `, which is a syntax error at best and a
  // silently different query at worst.
  const result = substitute('d > ${V_DATE}', pattern(), values({ V_DATE: '' }));
  assert.equal(result.sql, 'd > ${V_DATE}');
  assert.deepEqual(result.missing, ['V_DATE']);
});

test('an unknown placeholder is reported and left in place', () => {
  const result = substitute('d > ${V_DATE} AND x = ${OTHER}', pattern(), values({ V_DATE: '2026-01-01' }));
  assert.equal(result.sql, "d > 2026-01-01 AND x = ${OTHER}");
  assert.deepEqual(result.missing, ['OTHER']);
});

test('each missing name is reported once', () => {
  const result = substitute('${A} ${A} ${B}', pattern(), values({}));
  assert.deepEqual(result.missing, ['A', 'B']);
});

test('text with no variables passes through unchanged', () => {
  const sql = 'SELECT * FROM users WHERE id = 1';
  const result = substitute(sql, pattern(), values({}));
  assert.equal(result.sql, sql);
  assert.deepEqual(result.missing, []);
});

test('a value containing characters that matter to replace() is inserted literally', () => {
  // A `$` in a replacement string means a capture-group reference in String.replace, which is why the
  // callback form is used. Verified rather than assumed.
  const result = substitute('x = ${V}', pattern(), values({ V: "a$&b$'c$1" }));
  assert.equal(result.sql, "x = a$&b$'c$1");
});

test('repeated calls give the same answer, despite the global flag', () => {
  // A global regex keeps its lastIndex, so a naive implementation returns an empty list the second
  // time it is called.
  const text = '${A} ${B}';
  assert.deepEqual(variableNames(text, pattern()), ['A', 'B']);
  assert.deepEqual(variableNames(text, pattern()), ['A', 'B']);
  assert.equal(substitute(text, pattern(), values({ A: '1', B: '2' })).sql, '1 2');
  assert.equal(substitute(text, pattern(), values({ A: '1', B: '2' })).sql, '1 2');
});

test('an empty pattern disables substitution', () => {
  assert.equal(compilePattern('  '), undefined);
  assert.deepEqual(variableNames('${A}', undefined), []);
  assert.equal(substitute('${A}', undefined, values({ A: '1' })).sql, '${A}');
});

test('a pattern that cannot compile is rejected rather than thrown', () => {
  assert.equal(compilePattern('('), undefined);
  assert.equal(compilePattern('[a-'), undefined);
  assert.equal(compilePattern('a{2,1}'), undefined);
});

test('a pattern that compiles but cannot match is kept, and simply finds nothing', () => {
  // `'${'` is *not* an error: `$` is an anchor and a bare `{` is a literal under Annex B, so it
  // compiles into something that never matches. Rejecting it would mean deciding which regexes are
  // useless, which is not decidable; the panel showing no variables is the honest outcome.
  const never = compilePattern('${');
  assert.ok(never);
  assert.deepEqual(variableNames('${V_DATE}', never), []);
});

test('a custom pattern works, including one with no capture group', () => {
  const colon = compilePattern(':([A-Za-z_][A-Za-z0-9_]*)');
  assert.deepEqual(variableNames('WHERE d = :V_DATE', colon), ['V_DATE']);
  assert.equal(substitute('d = :V_DATE', colon, values({ V_DATE: 'x' })).sql, 'd = x');

  // No capture group: the whole match is the name, which is the only workable reading.
  const whole = compilePattern('%[A-Z_]+%');
  assert.equal(substitute('a %LIMIT% b', whole, values({ '%LIMIT%': '10' })).sql, 'a 10 b');
});
