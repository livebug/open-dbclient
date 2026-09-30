import type { CellValue } from '../bridge/protocol';
import type { DescribedTable, TableDetail } from '../model/tableDetails';
// Explicit extension: this module is imported by its test, and Node's own type stripping resolves
// specifiers literally.
import { otherColumns, TABLE_REMARK_COLUMNS } from './metadataQueries.ts';

/**
 * Reading the rows a metadata rule returned.
 *
 * Kept apart from the service that runs the statements because this half is pure: it turns positions and
 * strings into the table descriptions the tree draws, and it is where the interesting decisions live - what
 * counts as the comment, what counts as extra information, what happens when a row has no name. Those are
 * worth testing without a database, a bridge, or a connection.
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
