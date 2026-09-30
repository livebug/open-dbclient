import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CellValue } from '../bridge/protocol.ts';
import {
  columnFromRow,
  indexFromRow,
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

// ---------------------------------------------------------------------------
// Columns and indexes
// ---------------------------------------------------------------------------

/** Reads one row of a `columns` rule the way the service does. */
function readColumn(columns: readonly string[], values: readonly CellValue[], position = 1) {
  const [row] = toMetadataRows(
    columns.map((column) => column.toUpperCase()),
    [values],
  );
  return columnFromRow(row, position);
}

/** Reads one row of an `indexes` rule the way the service does. */
function readIndex(columns: readonly string[], values: readonly CellValue[], position = 1) {
  const [row] = toMetadataRows(
    columns.map((column) => column.toUpperCase()),
    [values],
  );
  return indexFromRow(row, position);
}

test('a column needs a name and nothing else', () => {
  const column = readColumn(['COLUMN_NAME'], ['AMT_01']);

  assert.equal(column?.name, 'AMT_01');
  assert.equal(column?.typeName, 'UNKNOWN', 'a type nobody gave is said to be unknown, not invented');
  assert.equal(column?.displayType, 'UNKNOWN');
  assert.equal(column?.primaryKey, false);
  assert.equal(column?.ordinal, 1, 'the row position is the ordinal');
  assert.equal(
    column?.nullableKnown,
    false,
    'not knowing is different from knowing it is not null - the tree shows a ? and nothing else',
  );
  assert.equal(readColumn(['COLUMN_NAME'], [null]), undefined, 'a row without a name is dropped');
});

test('every column field a rule may supply is read', () => {
  const column = readColumn(
    [
      'COLUMN_NAME',
      'TYPE_NAME',
      'COLUMN_SIZE',
      'DECIMAL_DIGITS',
      'IS_NULLABLE',
      'COLUMN_DEF',
      'REMARKS',
      'ORDINAL_POSITION',
      'IS_PRIMARY_KEY',
      'IS_AUTOINCREMENT',
      'IS_GENERATEDCOLUMN',
    ],
    ['id', 'NUMERIC', 20, 4, 'NO', 'nextval(1)', '主键', 3, true, true, false],
  );

  assert.equal(column?.displayType, 'NUMERIC(20,4)');
  assert.equal(column?.size, 20);
  assert.equal(column?.decimalDigits, 4);
  assert.equal(column?.nullable, false);
  assert.equal(column?.nullableKnown, true);
  assert.equal(column?.defaultValue, 'nextval(1)');
  assert.equal(column?.remarks, '主键');
  assert.equal(column?.ordinal, 3);
  assert.equal(column?.primaryKey, true);
  assert.equal(column?.autoIncrement, true);
  assert.equal(column?.generated, false);
});

test('a yes is a yes whichever way the catalog spells it', () => {
  // `information_schema` says YES, JDBC's own columns say true or 1, and a hand-written rule says whatever
  // the person who wrote it had to hand. Reading `t` as no would silently drop the key icon.
  for (const value of [true, 1, '1', 'YES', 'yes', 'Y', 'TRUE', 't']) {
    assert.equal(readColumn(['COLUMN_NAME', 'IS_PRIMARY_KEY'], ['id', value])?.primaryKey, true, String(value));
  }
  for (const value of [false, 0, '0', 'NO', 'no', 'N', 'FALSE', 'f', null, '']) {
    assert.equal(readColumn(['COLUMN_NAME', 'IS_PRIMARY_KEY'], ['id', value])?.primaryKey, false, String(value));
  }
});

test('nullability is read from either spelling, and unknown stays unknown', () => {
  assert.equal(readColumn(['COLUMN_NAME', 'NULLABLE'], ['c', 0])?.nullable, false);
  assert.equal(readColumn(['COLUMN_NAME', 'NULLABLE'], ['c', 1])?.nullable, true);
  assert.equal(
    readColumn(['COLUMN_NAME', 'NULLABLE'], ['c', 2])?.nullableKnown,
    false,
    '2 means the driver does not know',
  );
  assert.equal(readColumn(['COLUMN_NAME', 'IS_NULLABLE'], ['c', 'NO'])?.nullable, false);
  assert.equal(readColumn(['COLUMN_NAME', 'IS_NULLABLE'], ['c', ''])?.nullableKnown, false);
});

test('a type is shown with its length once, not twice', () => {
  // A database that already printed the length - `format_type`, `column_type` - keeps its own text; a rule
  // that selected a bare name and a size gets the length added.
  assert.equal(readColumn(['COLUMN_NAME', 'TYPE_NAME'], ['c', 'character varying(20)'])?.displayType, 'character varying(20)');
  assert.equal(readColumn(['COLUMN_NAME', 'TYPE_NAME', 'COLUMN_SIZE'], ['c', 'varchar', 50])?.displayType, 'varchar(50)');
  assert.equal(
    readColumn(['COLUMN_NAME', 'TYPE_NAME', 'COLUMN_SIZE'], ['c', 'integer', 10])?.displayType,
    'integer',
    'a length on an integer is a width in bytes, not something a reader wants to see',
  );
  assert.equal(
    readColumn(['COLUMN_NAME', 'TYPE_NAME', 'COLUMN_SIZE'], ['c', 'TEXT', 2_000_000_000])?.displayType,
    'TEXT',
    'that size is how some drivers say "unbounded"',
  );
});

test('a column carries no JDBC type, and says so', () => {
  const column = readColumn(['COLUMN_NAME', 'TYPE_NAME'], ['c', 'varchar']);

  assert.equal(column?.jdbcType, 1111, 'OTHER');
  assert.equal(column?.jdbcTypeName, 'varchar', 'the name is what gets displayed');
});

test('an index row needs a name, and takes uniqueness from whichever column it has', () => {
  assert.equal(readIndex(['INDEX_NAME'], [null]), undefined);

  const notUnique = readIndex(['INDEX_NAME', 'NON_UNIQUE'], ['idx', 1]);
  assert.equal(notUnique?.unique, false);
  assert.equal(readIndex(['INDEX_NAME', 'NON_UNIQUE'], ['idx', 0])?.unique, true);

  // The other spelling, which a rule written against a catalog view is more likely to use.
  assert.equal(readIndex(['INDEX_NAME', 'IS_UNIQUE'], ['idx', true])?.unique, true);
  assert.equal(readIndex(['INDEX_NAME', 'IS_UNIQUE'], ['idx', false])?.unique, false);
});

test('the rest of an index row is read, and defaults to what the driver would have said', () => {
  const index = readIndex(
    ['INDEX_NAME', 'COLUMN_NAME', 'SEQ_IN_INDEX', 'ASC_OR_DESC', 'TYPE_NAME'],
    ['idx_orders', 'created_at', 2, 'D', 'btree'],
  );

  assert.equal(index?.columnName, 'created_at');
  assert.equal(index?.ordinal, 2);
  assert.equal(index?.ascending, false);
  assert.equal(index?.typeName, 'btree', 'a rule that says what kind of index it is gets to say it');

  const bare = readIndex(['INDEX_NAME'], ['idx'], 4);
  assert.equal(bare?.ordinal, 4);
  assert.equal(bare?.type, 3);
  assert.equal(bare?.typeName, 'other', 'the same word the bridge uses for an unclassified index');
});
