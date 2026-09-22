import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeSqlContext, referencedTables, tokenize } from './sqlContext.ts';

/**
 * Tests for SQL context analysis.
 *
 * These matter more than most unit tests because completion quality is judged on incomplete input:
 * if the analyser is confused by a half-written statement, the feature fails exactly when the user
 * needs it. Every case below is written with the cursor marked by `|`.
 */

/** Splits a cursor-marked string into SQL and offset. */
function withCursor(source: string): { sql: string; offset: number } {
  const offset = source.indexOf('|');
  assert.ok(offset >= 0, 'the test input must mark the cursor with |');
  return { sql: source.slice(0, offset) + source.slice(offset + 1), offset };
}

function analyze(source: string) {
  const { sql, offset } = withCursor(source);
  return analyzeSqlContext(sql, offset);
}

test('a word after FROM asks for tables', () => {
  const context = analyze('SELECT * FROM us|');
  assert.equal(context.target, 'table');
  assert.equal(context.prefix, 'us');
  assert.equal(context.qualifier, undefined);
});

test('an empty position after FROM asks for tables', () => {
  const context = analyze('SELECT * FROM |');
  assert.equal(context.target, 'table');
  assert.equal(context.prefix, '');
});

test('a position after SELECT asks for columns', () => {
  assert.equal(analyze('SELECT |').target, 'column');
  assert.equal(analyze('SELECT a, |').target, 'column');
});

test('a qualifier makes it a column request', () => {
  const context = analyze('SELECT * FROM users u WHERE u.|');
  assert.equal(context.target, 'column');
  assert.equal(context.qualifier, 'u');
  assert.equal(context.prefix, '');
});

test('a qualifier with a partial name keeps both', () => {
  const context = analyze('SELECT * FROM users u WHERE u.na|');
  assert.equal(context.target, 'column');
  assert.equal(context.qualifier, 'u');
  assert.equal(context.prefix, 'na');
  // The replacement range must cover only the fragment being typed. Starting it at the qualifier
  // would mean accepting a suggestion rewrote `u.` as well, producing `u.id` only by luck and
  // destroying the alias as soon as the user had typed anything else.
  assert.equal(context.replaceStart, 'SELECT * FROM users u WHERE u.'.length);
});

test('the nearest keyword wins, so a nested FROM asks for tables', () => {
  const context = analyze('SELECT * FROM orders WHERE id IN (SELECT order_id FROM |)');
  assert.equal(context.target, 'table');
});

test('a JOIN asks for tables', () => {
  assert.equal(analyze('SELECT * FROM a JOIN |').target, 'table');
  assert.equal(analyze('SELECT * FROM a LEFT JOIN |').target, 'table');
});

test('AND and OR inside a WHERE ask for columns', () => {
  assert.equal(analyze('SELECT * FROM t WHERE id = 1 AND |').target, 'column');
  assert.equal(analyze('SELECT * FROM t WHERE id = 1 OR |').target, 'column');
});

test('an INSERT asks for a table then for columns', () => {
  assert.equal(analyze('INSERT INTO |').target, 'table');
  assert.equal(analyze('INSERT INTO t (|').target, 'column');
  assert.equal(analyze('INSERT INTO t (a) VALUES (|').target, 'column');
});

test('an UPDATE asks for a table then for columns', () => {
  assert.equal(analyze('UPDATE |').target, 'table');
  assert.equal(analyze('UPDATE t SET |').target, 'column');
});

test('inside a string literal nothing is offered', () => {
  const context = analyze("SELECT * FROM t WHERE name = 'ab|");
  assert.equal(context.target, 'none');
});

test('inside a comment nothing is offered', () => {
  const context = analyze('SELECT * FROM t -- trailing |');
  assert.equal(context.target, 'none');
  assert.equal(analyze('SELECT * FROM t /* block |').target, 'none');
});

test('a closed literal does not suppress the following context', () => {
  const context = analyze("SELECT * FROM t WHERE name = 'x' AND |");
  assert.equal(context.target, 'column');
});

test('keywords from a previous statement do not leak across a separator', () => {
  const context = analyze('SELECT a FROM t1; SELECT * FROM |');
  assert.equal(context.target, 'table');
  // The reference list must belong to the second statement only.
  assert.deepEqual(
    context.references.map((reference) => reference.name),
    [],
  );
});

test('references pick up bare aliases', () => {
  const references = referencedTables('SELECT * FROM users u JOIN orders o ON u.id = o.user_id');
  assert.deepEqual(references, [
    { name: 'users', alias: 'u' },
    { name: 'orders', alias: 'o' },
  ]);
});

test('references pick up AS aliases', () => {
  const references = referencedTables('SELECT * FROM users AS u');
  assert.deepEqual(references, [{ name: 'users', alias: 'u' }]);
});

test('a table without an alias is recorded without one', () => {
  assert.deepEqual(referencedTables('SELECT * FROM users'), [{ name: 'users' }]);
});

test('create table does not look like a table reference', () => {
  // `TABLE` follows `CREATE`, and treating it as a reference would offer columns of a nonexistent
  // table named "users" in the statement below.
  const references = referencedTables('CREATE TABLE users (id INTEGER)');
  assert.deepEqual(
    references.map((reference) => reference.name),
    [],
  );
});

test('a schema-qualified name is kept whole', () => {
  assert.deepEqual(referencedTables('SELECT * FROM public.users'), [{ name: 'public.users' }]);
  assert.deepEqual(referencedTables('SELECT * FROM sales.orders o'), [
    { name: 'sales.orders', alias: 'o' },
  ]);
});

test('quoted identifiers are unquoted', () => {
  assert.deepEqual(referencedTables('SELECT * FROM "my table" t'), [
    { name: 'my table', alias: 't' },
  ]);
  assert.deepEqual(referencedTables('SELECT * FROM `db`.`tbl`'), [{ name: 'db.tbl' }]);
});

test('a clause keyword after a table name is not mistaken for an alias', () => {
  const references = referencedTables('SELECT * FROM users WHERE id = 1');
  assert.deepEqual(references, [{ name: 'users' }]);
});

test('an unfinished statement at the very start offers nothing in particular', () => {
  assert.equal(analyze('|').target, 'none');
  assert.equal(analyze('sel|').target, 'none');
  assert.equal(analyze('sel|').prefix, 'sel');
});

test('tokenizer respects doubled quotes inside a literal', () => {
  const tokens = tokenize("SELECT 'it''s' FROM t", 0, 21);
  const quoted = tokens.filter((token) => token.kind === 'quoted');
  assert.equal(quoted.length, 1);
  assert.equal(quoted[0].text, "'it''s'");
});

test('tokenizer sees a semicolon inside a literal as part of the literal', () => {
  const tokens = tokenize("SELECT 'a;b'", 0, 11);
  assert.equal(tokens.some((token) => token.kind === 'punct' && token.text === ';'), false);
});
