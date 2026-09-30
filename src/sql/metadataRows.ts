import type { CellValue, ColumnInfo, IndexInfo } from '../bridge/protocol';
import type { DescribedTable, TableDetail } from '../model/tableDetails';
// Explicit extension: this module is imported by its test, and Node's own type stripping resolves
// specifiers literally.
import { otherColumns, TABLE_REMARK_COLUMNS } from './metadataQueries.ts';

/**
 * Reading the rows a metadata rule returned.
 *
 * Kept apart from the service that runs the statements because this half is pure: it turns positions and
 * strings into the descriptions the tree draws, and it is where the interesting decisions live - what
 * counts as the comment, what counts as extra information, what happens when a row has no name, which
 * spellings a rule may use for a boolean. Those are worth testing without a database, a bridge, or a
 * connection.
 */

/** A row of a metadata rule's result, with the column names upper-cased. */
export type MetadataRow = ReadonlyMap<string, CellValue>;

/** What a rule returned, with the result columns in the order the statement produced them. */
export interface MetadataResult {
  readonly columns: readonly string[];
  readonly rows: readonly MetadataRow[];
}

/**
 * What a row is being read against.
 *
 * Narrower than the service's own request type on purpose: the mapping cares about three fields, and
 * depending on only those is what lets it be called from a test with a literal.
 */
export interface TableRowContext {
  readonly catalog?: string;
  readonly schema?: string;
  /** `TABLE_TYPE` labels the caller asked for; a row of any other type is dropped. */
  readonly types?: readonly string[];
}

export function toMetadataRows(
  names: readonly string[],
  rows: readonly (readonly CellValue[])[],
): MetadataRow[] {
  return rows.map((values) => {
    const row = new Map<string, CellValue>();
    names.forEach((name, index) => row.set(name, values[index] ?? null));
    return row;
  });
}

/** Reads a cell as text, or undefined when it is absent or null. */
export function rowText(row: MetadataRow, key: string): string | undefined {
  const value = row.get(key);
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : String(value);
}

/** Reads a cell as a whole number, accepting the numeric strings a catalog view may return. */
export function rowNumber(row: MetadataRow, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = row.get(key);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.trunc(parsed);
      }
    }
  }
  return undefined;
}

/**
 * Reads a cell as a yes or no.
 *
 * Catalog rows spell this in every way there is: JDBC's `NON_UNIQUE` is `0`/`1`, its `IS_PRIMARY_KEY`
 * equivalent is often a real boolean, `information_schema` answers `YES`/`NO`, and a hand-written query
 * says whatever the user felt like. All of them are accepted, because a rule that reports the primary key
 * as `t` and is then read as `false` is a rule that silently shows the wrong key icon. Anything else -
 * including `null` and the empty string - is "no answer" rather than "no", which is what lets the caller
 * fall back to another column or to a default.
 */
export function rowBoolean(row: MetadataRow, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = row.get(key);
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    if (typeof value === 'string') {
      const text = value.trim().toUpperCase();
      if (['YES', 'Y', 'TRUE', 'T', '1'].includes(text)) {
        return true;
      }
      if (['NO', 'N', 'FALSE', 'F', '0'].includes(text)) {
        return false;
      }
    }
  }
  return undefined;
}

/**
 * The first of several accepted spellings that carries a value.
 *
 * Used for the comment, which different catalogs call different things. The order of `keys` is the
 * priority, so a rule that returns both `REMARKS` and `COMMENT` is read as JDBC would read it.
 */
export function firstRowText(row: MetadataRow, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = rowText(row, key);
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

/** The schema a row names, under either of the two spellings JDBC uses. */
export function schemaNameFromRow(row: MetadataRow): string | undefined {
  const name = rowText(row, 'TABLE_SCHEM') ?? rowText(row, 'SCHEMA_NAME');
  return name === undefined || name === '' ? undefined : name;
}

/**
 * Maps one row of a `tables` rule onto what the tree and the completion cache expect.
 *
 * Column names follow `DatabaseMetaData.getTables`, and everything except the name is optional: a rule
 * that answers only with names is still a working rule, and the schema the tree asked for is used when the
 * row does not carry one.
 *
 * Anything the statement returns that is not one of those columns is kept as the table's "other
 * information" and shown in the tree's tooltip. That is the whole extension mechanism: a database whose
 * catalogs carry something worth seeing gets to show it without this extension knowing that database
 * exists.
 */
export function tableFromRow(
  row: MetadataRow,
  request: TableRowContext,
  columns: readonly string[],
): DescribedTable | undefined {
  const name = rowText(row, 'TABLE_NAME');
  if (name === undefined || name === '') {
    return undefined;
  }

  const type = rowText(row, 'TABLE_TYPE') ?? 'TABLE';
  if (request.types && request.types.length > 0 && !request.types.includes(type)) {
    return undefined;
  }

  const details: TableDetail[] = otherColumns(columns)
    .map((column) => ({ name: column, value: rowText(row, column.toUpperCase()) ?? '' }))
    // A column the row left empty is not information, and showing `ENGINE: ` would suggest it is.
    .filter((detail) => detail.value !== '');

  const remark = firstRowText(row, TABLE_REMARK_COLUMNS);
  return {
    name,
    type,
    catalog: rowText(row, 'TABLE_CAT') ?? rowText(row, 'TABLE_CATALOG') ?? request.catalog,
    schema: schemaNameFromRow(row) ?? request.schema,
    // Left out rather than set to an empty string: the tree distinguishes "no comment" from a comment
    // that happens to be blank by whether the field is there at all.
    ...(remark === undefined ? {} : { remarks: remark }),
    ...(details.length === 0 ? {} : { details }),
  };
}

/**
 * The result columns a `columns` rule may use, grouped by the field they fill.
 *
 * Exported, and used by the reader below rather than written into it twice, because the shipped examples
 * are checked against this list: an example that aliases a column to a name nothing reads looks like it
 * works and silently produces `UNKNOWN` columns, which is the failure mode a test should catch rather than
 * a user.
 */
export const COLUMN_ROW_COLUMNS = {
  name: ['COLUMN_NAME'],
  type: ['TYPE_NAME', 'DATA_TYPE'],
  size: ['COLUMN_SIZE', 'CHARACTER_MAXIMUM_LENGTH', 'DATA_LENGTH'],
  decimalDigits: ['DECIMAL_DIGITS', 'DECIMAL_PLACES', 'NUMERIC_SCALE'],
  nullable: ['NULLABLE'],
  isNullable: ['IS_NULLABLE'],
  defaultValue: ['COLUMN_DEF', 'COLUMN_DEFAULT'],
  remarks: ['REMARKS', 'COMMENT'],
  ordinal: ['ORDINAL_POSITION', 'ORDINAL'],
  primaryKey: ['IS_PRIMARY_KEY', 'PRIMARY_KEY'],
  autoIncrement: ['IS_AUTOINCREMENT', 'AUTOINCREMENT', 'IS_IDENTITY'],
  generated: ['IS_GENERATEDCOLUMN', 'GENERATED'],
  jdbcType: ['JDBC_TYPE'],
  jdbcTypeName: ['JDBC_TYPE_NAME'],
} as const;

/**
 * Maps one row of a `columns` rule onto what the tree, Show Columns and the completion cache expect.
 *
 * Only `COLUMN_NAME` is required. Everything else falls back to something honest rather than to something
 * wrong: a type nobody supplied is `UNKNOWN`, which the tree prints as-is, and a nullability nobody
 * supplied is *unknown* rather than "not null" - that is what `nullableKnown` is for, and the tree then
 * shows a `?` instead of claiming a column cannot be null.
 *
 * @param position the row's place in the result, used as the ordinal when the rule did not select one.
 *                 Without it the tree would list columns in an arbitrary order, and ordinals are what a
 *                 user reads a table's layout by.
 */
export function columnFromRow(row: MetadataRow, position: number): ColumnInfo | undefined {
  const name = rowText(row, COLUMN_ROW_COLUMNS.name[0]);
  if (name === undefined || name === '') {
    return undefined;
  }

  const typeName =
    rowText(row, COLUMN_ROW_COLUMNS.type[0]) ?? rowText(row, COLUMN_ROW_COLUMNS.type[1]) ?? 'UNKNOWN';
  const size = rowNumber(row, COLUMN_ROW_COLUMNS.size) ?? 0;
  const decimalDigits = rowNumber(row, COLUMN_ROW_COLUMNS.decimalDigits);
  const nullable = nullableOf(row);

  return {
    name,
    typeName,
    displayType: displayTypeOf(typeName, size, decimalDigits),
    // A result set carries no JDBC type, so this is whatever the rule provided under `JDBC_TYPE` and
    // `OTHER` otherwise. Nothing in the extension branches on it - the name is what gets displayed - and
    // guessing a number from the type name would be a guess presented as a fact.
    jdbcType: rowNumber(row, COLUMN_ROW_COLUMNS.jdbcType) ?? 1111,
    jdbcTypeName: firstRowText(row, COLUMN_ROW_COLUMNS.jdbcTypeName) ?? typeName,
    size,
    decimalDigits,
    nullable: nullable.nullable,
    nullableKnown: nullable.known,
    defaultValue: firstRowText(row, COLUMN_ROW_COLUMNS.defaultValue),
    remarks: firstRowText(row, COLUMN_ROW_COLUMNS.remarks),
    ordinal: rowNumber(row, COLUMN_ROW_COLUMNS.ordinal) ?? position,
    primaryKey: rowBoolean(row, COLUMN_ROW_COLUMNS.primaryKey) ?? false,
    autoIncrement: rowBoolean(row, COLUMN_ROW_COLUMNS.autoIncrement) ?? false,
    generated: rowBoolean(row, COLUMN_ROW_COLUMNS.generated) ?? false,
  };
}

/**
 * Nullability, from whichever spelling the rule used.
 *
 * JDBC's numeric `NULLABLE` has three values and the third means "the driver does not know", which is why
 * this returns two fields rather than a boolean.
 */
function nullableOf(row: MetadataRow): { nullable: boolean; known: boolean } {
  const spelled = firstRowText(row, COLUMN_ROW_COLUMNS.isNullable)?.trim().toUpperCase();
  if (spelled === 'YES' || spelled === 'Y' || spelled === 'TRUE') {
    return { nullable: true, known: true };
  }
  if (spelled === 'NO' || spelled === 'N' || spelled === 'FALSE') {
    return { nullable: false, known: true };
  }

  const numeric = rowNumber(row, COLUMN_ROW_COLUMNS.nullable);
  if (numeric === 0) {
    return { nullable: false, known: true };
  }
  if (numeric === 1) {
    return { nullable: true, known: true };
  }
  return { nullable: false, known: false };
}

/**
 * The type as it should be shown, with the length put in when there is one to put in.
 *
 * A rule that selected `column_type` or `format_type` gets the length for free, because the database already
 * printed it; a rule that selected a bare type name and a size gets it added here. Whether a type has a
 * length is decided by its name, because a rule's rows carry no JDBC type - and the alternative would be to
 * print `NUMBER(2000000000)`, which is what some drivers report as "no limit".
 */
const LENGTH_BEARING_TYPE = /(CHAR|TEXT|BINARY|BLOB|DECIMAL|NUMERIC|BIT|RAW|INTERVAL)/i;

/** Sizes at or above this are a driver's way of saying "unbounded", not a length. */
const UNBOUNDED_SIZE = 1_000_000_000;

export function displayTypeOf(typeName: string, size: number, decimalDigits?: number): string {
  if (typeName.includes('(') || size <= 0 || size >= UNBOUNDED_SIZE) {
    return typeName;
  }
  if (!LENGTH_BEARING_TYPE.test(typeName)) {
    return typeName;
  }
  return decimalDigits !== undefined && decimalDigits > 0
    ? `${typeName}(${size},${decimalDigits})`
    : `${typeName}(${size})`;
}

/**
 * The result columns an `indexes` rule may use, in the same shape as the column list above.
 */
export const INDEX_ROW_COLUMNS = {
  name: ['INDEX_NAME', 'KEY_NAME'],
  columnName: ['COLUMN_NAME'],
  ordinal: ['ORDINAL_POSITION', 'SEQ_IN_INDEX'],
  nonUnique: ['NON_UNIQUE'],
  unique: ['IS_UNIQUE', 'UNIQUE'],
  ascending: ['ASC_OR_DESC'],
  ascendingFlag: ['IS_ASCENDING', 'ASCENDING'],
  type: ['TYPE'],
  typeName: ['TYPE_NAME'],
  cardinality: ['CARDINALITY'],
} as const;

/**
 * Maps one row of an `indexes` rule onto what the tree's index folder and Show Indexes expect.
 *
 * A rule returns one row per index *column*, which is what the driver's `getIndexInfo` does too: a
 * two-column index is two rows sharing a name and differing in ordinal.
 */
export function indexFromRow(row: MetadataRow, position: number): IndexInfo | undefined {
  const name = firstRowText(row, INDEX_ROW_COLUMNS.name);
  if (name === undefined || name === '') {
    return undefined;
  }

  const nonUnique = rowBoolean(row, INDEX_ROW_COLUMNS.nonUnique);
  const type = rowNumber(row, INDEX_ROW_COLUMNS.type) ?? 3;
  return {
    name,
    // `NON_UNIQUE` wins when it is there, because that is the spelling the same shape of row uses
    // everywhere else; a rule that said `IS_UNIQUE` instead is read the other way round.
    unique:
      nonUnique === undefined ? (rowBoolean(row, INDEX_ROW_COLUMNS.unique) ?? false) : !nonUnique,
    type,
    typeName: firstRowText(row, INDEX_ROW_COLUMNS.typeName) ?? indexTypeName(type),
    ordinal: rowNumber(row, INDEX_ROW_COLUMNS.ordinal) ?? position,
    columnName: firstRowText(row, INDEX_ROW_COLUMNS.columnName),
    ascending: ascendingOf(row),
    cardinality: rowNumber(row, INDEX_ROW_COLUMNS.cardinality),
  };
}

/** `A`/`D` as JDBC reports it, or a boolean under either of the names a catalog might use. */
function ascendingOf(row: MetadataRow): boolean | undefined {
  const text = firstRowText(row, INDEX_ROW_COLUMNS.ascending)?.trim().toUpperCase();
  if (text === 'A') {
    return true;
  }
  if (text === 'D') {
    return false;
  }
  return rowBoolean(row, INDEX_ROW_COLUMNS.ascendingFlag);
}

/** The names the bridge gives the driver's index types, so a rule that omits `TYPE` reads alike. */
function indexTypeName(type: number): string {
  switch (type) {
    case 0:
      return 'tableStatistics';
    case 1:
      return 'clustered';
    case 2:
      return 'hashed';
    case 3:
      return 'other';
    default:
      return 'unknown';
  }
}
