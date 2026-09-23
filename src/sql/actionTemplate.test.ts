/**
 * Tests for user-defined SQL actions.
 *
 * Run with: node --test src/sql/actionTemplate.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appliesTo,
  buildActionContext,
  expandAction,
  globToRegExp,
  matchDdlQuery,
  parseActions,
  parseDdlQueries,
  unresolvedPlaceholders,
} from './actionTemplate.ts';

const context = buildActionContext({
  catalog: 'shop',
  schema: 'public',
  table: 'orders',
  connectionName: 'Production',
  quote: '"',
});

test('reads a complete definition', () => {
  const { actions, problems } = parseActions([
    { id: 'count', label: 'Count rows', sql: 'SELECT COUNT(*) FROM ${qualifiedTable}', icon: '$(list-ordered)' },
  ]);
  assert.deepEqual(problems, []);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'count');
  assert.equal(actions[0].icon, '$(list-ordered)');
});

test('a missing or non-list setting yields nothing and says why', () => {
  assert.deepEqual(parseActions(undefined).actions, []);
  assert.deepEqual(parseActions(null).actions, []);
  const notAList = parseActions({ id: 'x' });
  assert.deepEqual(notAList.actions, []);
  assert.equal(notAList.problems.length, 1);
});

test('an unusable entry is dropped without taking the others with it', () => {
  const { actions, problems } = parseActions([
    { id: 'good', label: 'Good', sql: 'SELECT 1' },
    { label: 'no id', sql: 'SELECT 1' },
    { id: 'no-label', sql: 'SELECT 1' },
    { id: 'no-sql', label: 'Empty' },
    'nonsense',
  ]);
  assert.deepEqual(actions.map((action) => action.id), ['good']);
  assert.equal(problems.length, 4);
});

test('a duplicate id is rejected, keeping the first', () => {
  const { actions, problems } = parseActions([
    { id: 'same', label: 'First', sql: 'SELECT 1' },
    { id: 'same', label: 'Second', sql: 'SELECT 2' },
  ]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].label, 'First');
  assert.match(problems[0], /reuses the id/);
});

test('whitespace-only fields count as absent', () => {
  const { actions } = parseActions([{ id: '  ', label: 'x', sql: 'SELECT 1' }]);
  assert.deepEqual(actions, []);
});

test('appliesTo limits an action, and an unknown target is reported', () => {
  const { actions, problems } = parseActions([
    { id: 'a', label: 'A', sql: 'SELECT 1', appliesTo: ['column'] },
    { id: 'b', label: 'B', sql: 'SELECT 1', appliesTo: ['table', 'nonsense'] },
  ]);
  assert.deepEqual(actions[0].appliesTo, ['column']);
  assert.deepEqual(actions[1].appliesTo, ['table']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /nonsense/);
});

test('an action with no appliesTo is offered everywhere', () => {
  const { actions } = parseActions([{ id: 'a', label: 'A', sql: 'SELECT 1' }]);
  assert.equal(appliesTo(actions[0], 'table'), true);
  assert.equal(appliesTo(actions[0], 'view'), true);
  assert.equal(appliesTo(actions[0], 'column'), true);
});

test('an action with appliesTo is only offered where it says', () => {
  const { actions } = parseActions([{ id: 'a', label: 'A', sql: 'SELECT 1', appliesTo: ['table'] }]);
  assert.equal(appliesTo(actions[0], 'table'), true);
  assert.equal(appliesTo(actions[0], 'view'), false);
  assert.equal(appliesTo(actions[0], 'column'), false);
});

test('the raw placeholders are the names the driver reported', () => {
  // Not quoted: this is the form that belongs inside a string literal or after Hive's DESC.
  const sql = 'DESC ${qualified}';
  assert.equal(expandAction(sql, context), 'DESC public.orders');
});

test('the quoted placeholders are wrapped by the database quoting character', () => {
  const sql = 'SELECT * FROM ${quotedQualified} JOIN ${quotedTable} ON 1 = 1';
  assert.equal(expandAction(sql, context), 'SELECT * FROM "public"."orders" JOIN "orders" ON 1 = 1');
});

test('a name containing the quote character is doubled', () => {
  const awkward = buildActionContext({ schema: 'p', table: 'we"ird', connectionName: 'c', quote: '"' });
  assert.equal(awkward.quotedTable, '"we""ird"');
});

test('a database that cannot quote leaves the name bare', () => {
  const bare = buildActionContext({ table: 'mixed Case', connectionName: 'c', quote: undefined });
  assert.equal(bare.quotedTable, 'mixed Case');
  assert.equal(bare.qualified, 'mixed Case');
});

test('a schema-less database does not produce a leading dot', () => {
  // The failure this prevents: `DESC .table`, which no Hive server will parse.
  const noSchema = buildActionContext({ table: 'orders', connectionName: 'c', quote: '"' });
  assert.equal(noSchema.qualified, 'orders');
  assert.equal(noSchema.quotedQualified, '"orders"');
});

test('an unavailable placeholder is left in place rather than blanked', () => {
  // Blanking it would produce a query that runs and returns the wrong answer, which is the failure
  // mode worth engineering against.
  assert.equal(expandAction('SELECT ${nonsense}', context), 'SELECT ${nonsense}');
});

test('column is left in place for an action that is not offered on a column', () => {
  assert.equal(expandAction('SELECT ${column}', context), 'SELECT ${column}');
});

test('column expands when the context has one', () => {
  const withColumn = buildActionContext({
    schema: 'public',
    table: 'orders',
    column: 'id',
    connectionName: 'c',
    quote: '"',
  });
  assert.equal(expandAction('SELECT ${quotedColumn}', withColumn), 'SELECT "id"');
  assert.equal(expandAction('SELECT ${column}', withColumn), 'SELECT id');
});

test('unresolved placeholders are reported once each', () => {
  const missing = unresolvedPlaceholders('SELECT ${a}, ${b}, ${a}, ${table}', context);
  assert.deepEqual(missing, ['${a}', '${b}']);
});

test('a resolved template reports nothing missing', () => {
  assert.deepEqual(unresolvedPlaceholders('SELECT * FROM ${quotedQualified}', context), []);
  assert.deepEqual(unresolvedPlaceholders('DESC ${qualified}', context), []);
});

test('a template with no placeholders is returned unchanged', () => {
  assert.equal(expandAction('SELECT 1', context), 'SELECT 1');
  assert.deepEqual(unresolvedPlaceholders('SELECT 1', context), []);
});

// ---------------------------------------------------------------------------
// DDL queries
// ---------------------------------------------------------------------------

test('reads a DDL query rule, generating an id when none is given', () => {
  const { queries, problems } = parseDdlQueries([
    { match: 'jdbc:hive2:*', sql: 'DESC ${qualified}' },
    { id: 'pg', match: 'jdbc:postgresql:*', sql: "SELECT pg_get_tabledef('${qualified}')" },
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(queries.map((query) => query.id), ['ddl-1', 'pg']);
  assert.equal(queries[0].sql, 'DESC ${qualified}');
});

test('a rule with no match applies to every connection', () => {
  const { queries } = parseDdlQueries([{ id: 'any', sql: 'SELECT 1' }]);
  assert.equal(queries[0].match, undefined);
  assert.equal(matchDdlQuery('jdbc:anything:at:all', queries)?.id, 'any');
});

test('a rule without SQL is dropped and named', () => {
  const { queries, problems } = parseDdlQueries([
    { id: 'good', sql: 'SELECT 1' },
    { id: 'empty', sql: '   ' },
    { id: 'missing' },
  ]);
  assert.deepEqual(queries.map((query) => query.id), ['good']);
  assert.equal(problems.length, 2);
});

test('a duplicate DDL query id is rejected, keeping the first', () => {
  const { queries, problems } = parseDdlQueries([
    { id: 'same', sql: 'SELECT 1' },
    { id: 'same', sql: 'SELECT 2' },
  ]);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].sql, 'SELECT 1');
  assert.match(problems[0], /reuses the id/);
});

test('a non-list DDL queries setting is reported', () => {
  const { queries, problems } = parseDdlQueries({ id: 'x', sql: 'SELECT 1' });
  assert.deepEqual(queries, []);
  assert.equal(problems.length, 1);
});

test('the glob wildcard matches any run of characters', () => {
  assert.equal(globToRegExp('jdbc:hive2:*').test('jdbc:hive2://host:10000/default'), true);
  assert.equal(globToRegExp('jdbc:hive2:*').test('jdbc:postgresql://host/db'), false);
});

test('the glob is anchored, so a partial match is not a match', () => {
  // Without anchoring, `postgres` would select `jdbc:not-postgres:...`, which is the kind of silent
  // wrong-database match that is hard to notice.
  assert.equal(globToRegExp('jdbc:postgresql:*').test('jdbc:postgresql://h/db'), true);
  assert.equal(globToRegExp('postgres').test('jdbc:postgresql://h/db'), false);
});

test('the glob is case-insensitive and treats regex characters literally', () => {
  assert.equal(globToRegExp('JDBC:hive2:*').test('jdbc:hive2://h'), true);
  // A dot is a literal dot, not "any character".
  assert.equal(globToRegExp('jdbc.hive2').test('jdbcXhive2'), false);
  assert.equal(globToRegExp('jdbc:h2:mem:test(db)').test('jdbc:h2:mem:test(db)'), true);
});

test('a question mark is literal, not a wildcard', () => {
  assert.equal(globToRegExp('jdbc:hsqldb:mem:?').test('jdbc:hsqldb:mem:x'), false);
  assert.equal(globToRegExp('jdbc:hsqldb:mem:?').test('jdbc:hsqldb:mem:?'), true);
});

test('the first matching rule wins, so a catch-all after it is a fallback', () => {
  const { queries } = parseDdlQueries([
    { id: 'hive', match: 'jdbc:hive2:*', sql: 'DESC ${qualified}' },
    { id: 'fallback', sql: 'SELECT 1' },
  ]);
  assert.equal(matchDdlQuery('jdbc:hive2://h', queries)?.id, 'hive');
  assert.equal(matchDdlQuery('jdbc:mysql://h', queries)?.id, 'fallback');
});

test('with no rules there is no match, which is what keeps the built-in generator in use', () => {
  assert.equal(matchDdlQuery('jdbc:sqlite:/tmp/x.db', []), undefined);
  assert.equal(matchDdlQuery('jdbc:sqlite:/tmp/x.db', parseDdlQueries([{ id: 'h', match: 'jdbc:hive2:*', sql: 'DESC x' }]).queries), undefined);
});
