/**
 * Tests for the statements the result grid generates.
 *
 * Run with: node --test src/sql/statementBuilder.test.ts
 *
 * The literal cases are deliberately the same ones `SqlInsertExportTests` pins on the Java side: the
 * grid and the exporter write the same kinds of value and must not disagree about any of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStatements,
  countStatement,
  literal,
  qualifiedTableName,
  quoteIdentifier,
  sourceTableOf,
  unusableReason,
  type SqlValue,
  type StatementColumn,
} from './statementBuilder.ts';

const COLUMNS: readonly StatementColumn[] = [
  { name: 'id', jdbcTypeName: 'INTEGER', tableName: 'orders', schemaName: 'public' },
  { name: 'total', jdbcTypeName: 'DECIMAL', tableName: 'orders', schemaName: 'public' },
  { name: 'note', jdbcTypeName: 'VARCHAR', tableName: 'orders', schemaName: 'public' },
];

const TABLE = { schema: 'public', name: 'orders' };

// ---------------------------------------------------------------------------
// literals
// ---------------------------------------------------------------------------

test('a number is written bare', () => {
  assert.equal(literal(42, 'INTEGER'), '42');
  assert.equal(literal(1.5, 'DOUBLE'), '1.5');
});

test('null is NULL, in upper case', () => {
  assert.equal(literal(null, 'VARCHAR'), 'NULL');
});

test('a boolean is spelled out, because PostgreSQL rejects 1 and 0 for it', () => {
  assert.equal(literal(true, 'BOOLEAN'), 'TRUE');
  assert.equal(literal(false, 'BOOLEAN'), 'FALSE');
});

test('text is quoted, with embedded quotes doubled', () => {
  assert.equal(literal("it's", 'VARCHAR'), "'it''s'");
  assert.equal(literal('', 'VARCHAR'), "''");
});

test('a numeric-looking string stays bare in a numeric column and is quoted anywhere else', () => {
  // The bridge keeps a BIGINT beyond 2^53 or a DECIMAL as text on purpose; quoting it would change
  // its type in the destination database.
  assert.equal(literal('9007199254740993', 'BIGINT'), '9007199254740993');
  assert.equal(literal('-1.25', 'DECIMAL'), '-1.25');
  assert.equal(literal('9007199254740993', 'VARCHAR'), "'9007199254740993'");
});

test('a numeric column holding text that is not numeric is quoted rather than guessed at', () => {
  assert.equal(literal('[error reading value: boom]', 'INTEGER'), "'[error reading value: boom]'");
});

test('an array travels as quoted text, because array syntax is vendor-specific', () => {
  assert.equal(literal([1, 2], 'ARRAY'), "'[1, 2]'");
});

// ---------------------------------------------------------------------------
// values that must not be used to identify a row
// ---------------------------------------------------------------------------

test('null, numbers and booleans are usable in a WHERE clause', () => {
  assert.equal(unusableReason(null), undefined);
  assert.equal(unusableReason(1), undefined);
  assert.equal(unusableReason(false), undefined);
  assert.equal(unusableReason('plain text'), undefined);
});

test('a placeholder the bridge left behind is not usable', () => {
  assert.match(unusableReason('[blob 12 bytes, use Export to save it]') ?? '', /binary|unreadable/);
  assert.match(unusableReason('[binary 4 bytes, use Export to save it]') ?? '', /binary|unreadable/);
  assert.match(unusableReason('[clob]') ?? '', /binary|unreadable/);
  assert.match(unusableReason('[error reading value: permission denied]') ?? '', /binary|unreadable/);
});

test('text the bridge cut at the cell ceiling is not usable', () => {
  assert.match(unusableReason('abc... [100 more characters omitted]') ?? '', /truncated/);
  assert.match(unusableReason('abc... [1 more character omitted]') ?? '', /truncated/);
});

test('an array is not usable, because no portable operator compares one', () => {
  assert.match(unusableReason([1, 2]) ?? '', /array/);
});

// ---------------------------------------------------------------------------
// identifiers and the source table
// ---------------------------------------------------------------------------

test('identifiers are quoted with the character the driver reported, doubling it when embedded', () => {
  assert.equal(quoteIdentifier('orders', '"'), '"orders"');
  assert.equal(quoteIdentifier('or"ders', '"'), '"or""ders"');
  assert.equal(quoteIdentifier('orders', undefined), 'orders');
});

test('a qualified name keeps only the parts the database has', () => {
  assert.equal(qualifiedTableName({ catalog: 'db', schema: 'public', name: 't' }, '"'), '"db"."public"."t"');
  assert.equal(qualifiedTableName({ schema: 'public', name: 't' }, '"'), '"public"."t"');
  assert.equal(qualifiedTableName({ name: 't' }, '"'), '"t"');
});

test('one table is found when every column names the same one', () => {
  assert.deepEqual(sourceTableOf(COLUMNS), { table: { catalog: undefined, schema: 'public', name: 'orders' } });
});

test('a result that names no table, or several, says so instead of guessing', () => {
  assert.match(sourceTableOf([{ name: 'a', jdbcTypeName: 'INTEGER' }]).reason ?? '', /does not name a table/);
  assert.match(
    sourceTableOf([
      { name: 'a', jdbcTypeName: 'INTEGER', tableName: 'orders' },
      { name: 'b', jdbcTypeName: 'INTEGER', tableName: 'customers' },
    ]).reason ?? '',
    /more than one table/,
  );
});

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

test('INSERT batches the selected rows and uses the physical column names', () => {
  const outcome = buildStatements({
    kind: 'insert',
    table: TABLE,
    columns: COLUMNS,
    rows: [
      [1, '2.50', 'first'],
      [2, null, "o'brien"],
    ],
    quote: '"',
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) {
    return;
  }
  assert.match(outcome.sql, /INSERT INTO "public"\."orders" \("id", "total", "note"\) VALUES/);
  assert.match(outcome.sql, /\(1, 2\.50, 'first'\)/);
  assert.match(outcome.sql, /\(2, NULL, 'o''brien'\)/);
  assert.deepEqual(outcome.warnings, []);
});

test('INSERT warns about a value that cannot be written back faithfully', () => {
  const outcome = buildStatements({
    kind: 'insert',
    table: TABLE,
    columns: COLUMNS,
    rows: [[1, null, '[blob 3 bytes, use Export to save it]']],
    quote: '"',
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) {
    return;
  }
  assert.equal(outcome.warnings.length, 1);
  assert.match(outcome.warnings[0], /^note: /);
  assert.match(outcome.sql, /^-- note: /m);
});

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

test('UPDATE sets every non-identity column when nothing was edited', () => {
  const outcome = buildStatements({
    kind: 'update',
    table: TABLE,
    columns: COLUMNS,
    rows: [[7, '3.00', 'hello']],
    identity: [0],
    quote: '"',
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) {
    return;
  }
  assert.match(outcome.sql, /UPDATE "public"\."orders" SET "total" = 3\.00, "note" = 'hello' WHERE "id" = 7;/);
  // The identity column identifies the row; it must not also be assigned.
  const setClause = outcome.sql.slice(outcome.sql.indexOf(' SET '), outcome.sql.indexOf(' WHERE '));
  assert.doesNotMatch(setClause, /"id"/);
});

test('UPDATE sets only the edited columns when there are edits', () => {
  const outcome = buildStatements({
    kind: 'update',
    table: TABLE,
    columns: COLUMNS,
    rows: [[7, '3.00', 'hello']],
    identity: [0],
    changes: [{ row: 0, column: 2, value: 'goodbye', isNull: false }],
    quote: '"',
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) {
    return;
  }
  assert.match(outcome.sql, /SET "note" = 'goodbye' WHERE "id" = 7;/);
  assert.doesNotMatch(outcome.sql, /"total" =/);
});

test('an edit can set NULL', () => {
  const outcome = buildStatements({
    kind: 'update',
    table: TABLE,
    columns: COLUMNS,
    rows: [[7, '3.00', 'hello']],
    identity: [0],
    changes: [{ row: 0, column: 2, value: '', isNull: true }],
    quote: '"',
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) {
    return;
  }
  assert.match(outcome.sql, /SET "note" = NULL WHERE "id" = 7;/);
});

test('a NULL identity value becomes IS NULL rather than = NULL', () => {
  const outcome = buildStatements({
    kind: 'delete',
    table: TABLE,
    columns: COLUMNS,
    rows: [[null, '3.00', 'hello']],
    identity: [0],
    quote: '"',
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) {
    return;
  }
  assert.match(outcome.sql, /WHERE "id" IS NULL;/);
});

test('a row whose identity value is a placeholder is skipped, with a warning', () => {
  const outcome = buildStatements({
    kind: 'delete',
    table: TABLE,
    columns: COLUMNS,
    rows: [
      [1, '3.00', 'ok'],
      ['[blob 3 bytes, use Export to save it]', '3.00', 'unusable key'],
    ],
    identity: [0],
    quote: '"',
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) {
    return;
  }
  assert.match(outcome.sql, /-- row 1\n/);
  assert.doesNotMatch(outcome.sql, /row 2\n/);
  assert.equal(outcome.warnings.length, 1);
  assert.match(outcome.warnings[0], /1 row\(s\) were skipped/);
});

test('UPDATE and DELETE refuse to run without an identity, and refuse when every row is unusable', () => {
  const noIdentity = buildStatements({
    kind: 'delete',
    table: TABLE,
    columns: COLUMNS,
    rows: [[1, '3.00', 'x']],
    quote: '"',
  });
  assert.equal(noIdentity.ok, false);

  const allUnusable = buildStatements({
    kind: 'delete',
    table: TABLE,
    columns: COLUMNS,
    rows: [[[1, 2], '3.00', 'x']],
    identity: [0],
    quote: '"',
  });
  assert.equal(allUnusable.ok, false);
  if (allUnusable.ok) {
    return;
  }
  assert.match(allUnusable.message, /None of the selected rows/);
});

test('INSERT needs no identity, but still needs columns and rows', () => {
  assert.equal(buildStatements({ kind: 'insert', table: TABLE, columns: [], rows: [[]] }).ok, false);
  assert.equal(buildStatements({ kind: 'insert', table: TABLE, columns: COLUMNS, rows: [] }).ok, false);
});

// ---------------------------------------------------------------------------
// COUNT
// ---------------------------------------------------------------------------

test('COUNT wraps the original statement so the number agrees with what was shown', () => {
  const counted = countStatement('SELECT a, b FROM t WHERE a > 1;');
  assert.equal(counted, 'SELECT COUNT(*) FROM (\nSELECT a, b FROM t WHERE a > 1\n) open_dbclient_count;');
});

test('COUNT accepts a CTE and refuses a statement that returns no rows', () => {
  assert.match(countStatement('WITH x AS (SELECT 1) SELECT * FROM x') ?? '', /^SELECT COUNT\(\*\)/);
  assert.equal(countStatement('UPDATE t SET a = 1'), undefined);
  assert.equal(countStatement(''), undefined);
});

// ---------------------------------------------------------------------------
// values that arrive as something other than a scalar
// ---------------------------------------------------------------------------

test('a nested array is rendered as text rather than dropped', () => {
  const value: SqlValue = [
    [1, 2],
    [3, 4],
  ];
  assert.equal(literal(value, 'ARRAY'), "'[[1, 2], [3, 4]]'");
});
