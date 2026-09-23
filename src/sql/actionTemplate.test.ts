/**
 * Tests for user-defined SQL actions.
 *
 * Run with: node --test src/sql/actionTemplate.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appliesTo,
  expandAction,
  parseActions,
  unresolvedPlaceholders,
  type ActionContext,
} from './actionTemplate.ts';

const context: ActionContext = {
  table: '"orders"',
  schema: '"public"',
  catalog: '"shop"',
  qualifiedTable: '"public"."orders"',
  connectionName: 'Production',
};

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

test('expands every known placeholder', () => {
  const sql = 'SELECT * FROM ${qualifiedTable} WHERE t = ${table} AND s = ${schema} AND c = ${catalog}';
  assert.equal(
    expandAction(sql, context),
    'SELECT * FROM "public"."orders" WHERE t = "orders" AND s = "public" AND c = "shop"',
  );
});

test('the connection name expands, since it is the one value that is not a real identifier', () => {
  assert.equal(
    expandAction("SELECT '${connectionName}' AS source", context),
    "SELECT 'Production' AS source",
  );
});

test('an unknown placeholder is left in place rather than blanked', () => {
  // Blanking it would produce a query that runs and returns the wrong answer, which is the failure
  // mode worth engineering against: `WHERE x = ` would be a syntax error, but `WHERE x = ` inside a
  // string, or `LIKE ''`, would not.
  assert.equal(expandAction('SELECT ${nonsense}', context), 'SELECT ${nonsense}');
});

test('column is left in place for an action that is not offered on a column', () => {
  assert.equal(expandAction('SELECT ${column}', context), 'SELECT ${column}');
});

test('column expands when the context has one', () => {
  assert.equal(expandAction('SELECT ${column}', { ...context, column: '"id"' }), 'SELECT "id"');
});

test('unresolved placeholders are reported once each', () => {
  const missing = unresolvedPlaceholders('SELECT ${a}, ${b}, ${a}, ${table}', context);
  assert.deepEqual(missing, ['${a}', '${b}']);
});

test('a resolved template reports nothing missing', () => {
  assert.deepEqual(unresolvedPlaceholders('SELECT * FROM ${qualifiedTable}', context), []);
});

test('a template with no placeholders is returned unchanged', () => {
  assert.equal(expandAction('SELECT 1', context), 'SELECT 1');
  assert.deepEqual(unresolvedPlaceholders('SELECT 1', context), []);
});
