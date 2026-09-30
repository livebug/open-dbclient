import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CellValue } from '../bridge/protocol.ts';
import {
  rowText,
  schemaNameFromRow,
  tableFromRow,
  toMetadataRows,
  type TableRowContext,
} from './metadataRows.ts';

/**
 * Tests for reading a metadata rule's rows.
 *
 * The behaviour worth pinning down is the part a user cannot see from the SQL they wrote: which spelling
 * of the comment is picked up, which columns are treated as part of the contract, and what happens to
 * everything else. Those decisions are why a rule can describe a database the extension has never heard
 * of, so they are tested directly rather than through a live connection.
 */

/** Reads one result row the way the service does. */
function describe(
  columns: readonly string[],
  values: readonly CellValue[],
  context: TableRowContext = {},
) {
  const [row] = toMetadataRows(
    columns.map((column) => column.toUpperCase()),
    [values],
  );
  return tableFromRow(row, context, columns);
}

test('a row is read by column name, so the SELECT may order them as it likes', () => {
  const table = describe(['REMARKS', 'TABLE_TYPE', 'TABLE_NAME'], ['订单', 'VIEW', 'v_orders']);

  assert.equal(table?.name, 'v_orders');
  assert.equal(table?.type, 'VIEW');
  assert.equal(table?.remarks, '订单');
});

test('the comment is accepted under the spellings catalogs actually use', () => {
  // `REMARKS` is JDBC's, `TABLE_COMMENT` is MySQL's information_schema, and `COMMENT` is what people
  // write when they alias a comment column by hand.
  assert.equal(describe(['TABLE_NAME', 'REMARKS'], ['t', '备注'])?.remarks, '备注');
  assert.equal(describe(['TABLE_NAME', 'TABLE_COMMENT'], ['t', '备注'])?.remarks, '备注');
  assert.equal(describe(['TABLE_NAME', 'COMMENT'], ['t', '备注'])?.remarks, '备注');
});

test('REMARKS wins when a row offers several spellings', () => {
  const table = describe(['TABLE_NAME', 'COMMENT', 'REMARKS'], ['t', '中文A', '中文B']);

  assert.equal(table?.remarks, '中文B');
});

test('a blank comment is no comment', () => {
  // Catalogs store an empty string for "documented as nothing", and a tree row reading `orders ·` would be
  // worse than one reading `orders`.
  const table = describe(['TABLE_NAME', 'REMARKS'], ['t', '']);

  assert.equal(table?.remarks, undefined);
  assert.ok(!('remarks' in (table ?? {})));
});

test('every column outside the contract becomes other information, in result order', () => {
  // Order is the user's: they wrote the SELECT list, and the order they wrote it in is the order they
  // want to read it back.
  const table = describe(
    ['TABLE_NAME', 'EST_ROWS', 'ENGINE'],
    ['orders', 12, 'InnoDB'],
  );

  assert.deepEqual(table?.details, [
    { name: 'EST_ROWS', value: '12' },
    { name: 'ENGINE', value: 'InnoDB' },
  ]);
});

test('the contract columns are never other information', () => {
  const table = describe(
    ['TABLE_SCHEM', 'TABLE_NAME', 'TABLE_TYPE', 'REMARKS', 'TABLE_CAT'],
    ['public', 'orders', 'TABLE', '订单', 'db'],
  );

  assert.equal(table?.schema, 'public');
  assert.equal(table?.catalog, 'db');
  assert.equal(table?.details, undefined);
});

test('an extra column the row left empty is not information', () => {
  const table = describe(['TABLE_NAME', 'SIZE', 'NOTE'], ['orders', null, '']);

  assert.equal(table?.details, undefined);
});

test('an unnamed result column is ignored rather than shown as a blank label', () => {
  const table = describe(['TABLE_NAME', '', '  '], ['orders', 1, 2]);

  assert.equal(table?.details, undefined);
});

test('a row without a name describes nothing', () => {
  assert.equal(describe(['TABLE_NAME', 'REMARKS'], [null, '备注']), undefined);
  assert.equal(describe(['TABLE_NAME', 'REMARKS'], ['', '备注']), undefined);
});

test('a type the caller did not ask for is dropped', () => {
  // The tree asks for tables and views separately, and both come back from one statement.
  assert.equal(describe(['TABLE_NAME', 'TABLE_TYPE'], ['v', 'VIEW'], { types: ['TABLE'] }), undefined);
  assert.equal(describe(['TABLE_NAME', 'TABLE_TYPE'], ['v', 'VIEW'], { types: ['VIEW'] })?.name, 'v');
  assert.equal(describe(['TABLE_NAME', 'TABLE_TYPE'], ['v', 'VIEW'])?.name, 'v');
});

test('catalog and schema fall back to what the tree asked for', () => {
  // A rule that answers with names only is still a working rule, and the tree's rows are still placed
  // under the schema the user expanded.
  const table = describe(['TABLE_NAME'], ['orders'], { catalog: 'db', schema: 'public' });

  assert.equal(table?.catalog, 'db');
  assert.equal(table?.schema, 'public');
});

test('TABLE_TYPE defaults rather than leaving the tree unable to place a row', () => {
  assert.equal(describe(['TABLE_NAME'], ['orders'])?.type, 'TABLE');
});

test('a schema row is read under either spelling', () => {
  const [row] = toMetadataRows(['TABLE_SCHEM'], [['public']]);
  const [mysql] = toMetadataRows(['SCHEMA_NAME'], [['sales']]);
  const [blank] = toMetadataRows(['TABLE_SCHEM'], [['']]);

  assert.equal(schemaNameFromRow(row), 'public');
  assert.equal(schemaNameFromRow(mysql), 'sales');
  assert.equal(schemaNameFromRow(blank), undefined);
});

test('a cell that is not text is read as its text form', () => {
  const [row] = toMetadataRows(['X', 'Y', 'Z'], [[12, true, null]]);

  assert.equal(rowText(row, 'X'), '12');
  assert.equal(rowText(row, 'Y'), 'true');
  assert.equal(rowText(row, 'Z'), undefined);
});
