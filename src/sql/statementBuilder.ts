// The explicit `.ts` extension is required here, not stylistic: this module is reached directly by
// `node --test`, whose ESM resolution does not guess extensions. See the note in `util/i18n.ts`.
import { t } from '../util/i18n.ts';

/**
 * Builds the SQL a user copies out of the result grid.
 *
 * <h2>Why this exists next to an exporter that already writes INSERTs</h2>
 *
 * `SqlInsertExport` writes a whole result to a file and is handed the rows by the bridge, which still
 * has the live `ResultSet`. What a person wants from a grid is different in three ways: it is a
 * *selection* rather than the whole result, it includes `UPDATE` and `DELETE`, and the rows are the
 * ones already on screen. The literal rules therefore have to be the same as the exporter's or the two
 * would disagree about, say, whether a `DECIMAL` that arrived as text may be written unquoted - so
 * they are mirrored here deliberately, case by case, and pinned by tests.
 *
 * <h2>Why some values cannot be used at all</h2>
 *
 * The bridge caps a cell at 65536 characters and describes binary columns as a placeholder. Those
 * values are perfectly good for display and useless for identifying a row: a `WHERE` built from a
 * truncated value either matches nothing or matches the wrong row, and silently changing the wrong
 * row is the one failure this feature must not have. {@link unusableReason} is the single place that
 * decides, and every consumer either excludes the value or skips the row.
 */

/** A cell value as the grid holds it: what the bridge produced, never an object except a SQL array. */
export type SqlValue = string | number | boolean | null | readonly SqlValue[];

/** One column of the result, with the source table it was read from when the driver reported one. */
export interface StatementColumn {
  readonly name: string;
  readonly jdbcTypeName: string;
  readonly tableName?: string;
  readonly schemaName?: string;
  readonly catalogName?: string;
}

/** The table a statement should target. */
export interface SourceTable {
  readonly catalog?: string;
  readonly schema?: string;
  readonly name: string;
}

/** An edit the user made in the grid, before it becomes a statement. */
export interface CellChange {
  /** Index into the request's `rows`. */
  readonly row: number;
  /** Index into the request's `columns`. */
  readonly column: number;
  /** The text the user typed. Used only when `isNull` is false. */
  readonly value: string;
  /** True when the user asked for NULL rather than for an empty string. */
  readonly isNull: boolean;
}

export type StatementKind = 'insert' | 'update' | 'delete';

export interface BuildRequest {
  readonly kind: StatementKind;
  readonly table: SourceTable;
  readonly columns: readonly StatementColumn[];
  /** The selected rows' original values, in `columns` order. */
  readonly rows: readonly (readonly SqlValue[])[];
  /** Column indexes that identify one row. Required for `update` and `delete`. */
  readonly identity?: readonly number[];
  readonly changes?: readonly CellChange[];
  /** The driver's identifier quote character; absent means the database cannot quote at all. */
  readonly quote?: string;
}

export type BuildOutcome =
  | {
      readonly ok: true;
      readonly sql: string;
      /** How many statements the text holds, for a one-line confirmation. */
      readonly statements: number;
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

/** Matches a decimal literal every database accepts unquoted. Mirrors `SqlInsertExport`. */
const NUMERIC_LITERAL = /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/** JDBC type names whose values may be written without quotes. Mirrors `SqlInsertExport`. */
const NUMERIC_TYPES = new Set([
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'DECIMAL',
  'NUMERIC',
  'FLOAT',
  'REAL',
  'DOUBLE',
]);

/** The bridge's stand-ins for a value it did not carry: binary, LOB, or a failed read. */
const PLACEHOLDER = /^\s*\[(binary|blob|clob|error reading value)\b/i;

/** The bridge's marker for text it cut at the per-cell ceiling. */
const TRUNCATED = /\d+\s+more\s+characters?\s+omitted\]\s*$/i;

/** Quotes an identifier with the character the database itself reported. */
export function quoteIdentifier(name: string, quote?: string): string {
  return quote ? quote + name.split(quote).join(quote + quote) + quote : name;
}

/** Renders `catalog.schema.name` with whatever parts are present, each quoted as the driver asks. */
export function qualifiedTableName(table: SourceTable, quote?: string): string {
  return [table.catalog, table.schema, table.name]
    .filter((part): part is string => part !== undefined && part !== '')
    .map((part) => quoteIdentifier(part, quote))
    .join('.');
}

/**
 * Whether a value can be used in a `WHERE`, and why not when it cannot.
 *
 * NULL is usable - `col IS NULL` is exact. Arrays are not: the bridge sends a SQL array as a list, and
 * no portable operator compares it. Placeholders and truncated text are not, for the reason in the
 * file header.
 */
export function unusableReason(value: SqlValue): string | undefined {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return undefined;
  }
  if (typeof value !== 'string') {
    return t('a SQL array cannot be compared');
  }
  if (PLACEHOLDER.test(value)) {
    return t('the bridge could not carry this value (binary or unreadable)');
  }
  if (TRUNCATED.test(value)) {
    return t('the value was truncated for display');
  }
  return undefined;
}

/**
 * Renders one value as a SQL literal.
 *
 * The two decisions worth naming: a string is written bare when its column is numeric and the text is
 * genuinely numeric, because the bridge keeps a `BIGINT` beyond 2^53 or a `DECIMAL` as text on
 * purpose and quoting it would change its type; and a boolean is spelled out, because PostgreSQL
 * rejects `1`/`0` for a boolean column.
 */
export function literal(value: SqlValue, jdbcTypeName: string): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value !== 'string') {
    // A SQL array: vendor-specific syntax, so it travels as text - the same choice the exporter makes.
    return quote(javaListText(value));
  }
  if (NUMERIC_TYPES.has(jdbcTypeName.toUpperCase()) && NUMERIC_LITERAL.test(value)) {
    return value;
  }
  return quote(value);
}

/** Doubles embedded single quotes, which every SQL dialect understands. */
function quote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Renders a nested list the way Java's `List.toString` does.
 *
 * Only so that a copied `INSERT` matches what the exporter would write for the same array: the value
 * is quoted text either way, and no database reads it back as an array.
 */
function javaListText(value: readonly SqlValue[]): string {
  return `[${value.map(listEntry).join(', ')}]`;
}

/** One element of {@link javaListText}: nested lists recurse, scalars render as Java would. */
function listEntry(entry: SqlValue): string {
  if (entry === null) {
    return 'null';
  }
  return Array.isArray(entry) ? javaListText(entry) : String(entry);
}

/**
 * The single table a result came from, or why it cannot be determined.
 *
 * A result of a join, or of an expression, has no one table to write back to. Determining this from
 * the columns the driver reported keeps the decision out of the dialect layer: the extension never
 * parses the user's SQL.
 */
export function sourceTableOf(
  columns: readonly StatementColumn[],
): { readonly table?: SourceTable; readonly reason?: string } {
  const names = [...new Set(columns.map((column) => column.tableName).filter((name): name is string => Boolean(name)))];
  if (names.length === 0) {
    return { reason: t('the result does not name a table, so there is nothing to write to') };
  }
  if (names.length > 1) {
    return { reason: t('the result comes from more than one table ({0})', names.join(', ')) };
  }
  const first = columns.find((column) => column.tableName === names[0]);
  return {
    table: {
      catalog: first?.catalogName,
      schema: first?.schemaName,
      name: names[0],
    },
  };
}

/** Builds the statements for the request, or explains why it cannot. */
export function buildStatements(request: BuildRequest): BuildOutcome {
  const { columns, rows, table, quote } = request;
  if (columns.length === 0) {
    return { ok: false, message: t('This result has no columns to write.') };
  }
  if (rows.length === 0) {
    return { ok: false, message: t('Select at least one row first.') };
  }

  const tableName = qualifiedTableName(table, quote);
  const warnings: string[] = [];

  if (request.kind === 'insert') {
    return { ok: true, sql: buildInsert(request, tableName, warnings), statements: rows.length, warnings };
  }

  const identity = request.identity ?? [];
  if (identity.length === 0) {
    return {
      ok: false,
      message: t('Choosing which column identifies a row is required before this statement can be written.'),
    };
  }

  const body: string[] = [];
  let skipped = 0;
  for (const [index, row] of rows.entries()) {
    const predicate = rowPredicate(row, identity, columns, quote);
    if (predicate === undefined) {
      skipped++;
      continue;
    }
    body.push(
      request.kind === 'update'
        ? buildUpdateRow(request, tableName, index, row, identity, predicate, warnings)
        : `-- row ${index + 1}\nDELETE FROM ${tableName} WHERE ${predicate};`,
    );
  }

  if (body.length === 0) {
    return {
      ok: false,
      message: t('None of the selected rows can be identified exactly, so no statement was written.'),
    };
  }
  if (skipped > 0) {
    warnings.push(
      t('{0} row(s) were skipped because a column that identifies them is not the original value.', skipped),
    );
  }
  return {
    ok: true,
    sql: [
      header(request, tableName, body.length),
      ...warnings.map((line) => `-- ${line}`),
      '',
      ...body,
    ].join('\n'),
    statements: body.length,
    warnings,
  };
}

/** The comment block every generated statement file starts with. */
function header(request: BuildRequest, tableName: string, statements: number): string {
  const kind = request.kind.toUpperCase();
  return [
    `-- ${t('Generated by Open DB Client from the result grid')}`,
    `-- ${kind} · ${tableName} · ${t('{0} statement(s)', statements)}`,
  ].join('\n');
}

/** One `INSERT` for every selected row, batched the way the exporter batches them. */
function buildInsert(request: BuildRequest, tableName: string, warnings: string[]): string {
  const { columns, rows, quote } = request;
  const columnList = columns.map((column) => quoteIdentifier(column.name, quote)).join(', ');
  const tuples = rows.map((row) => {
    const values = columns.map((column, index) => {
      const value = row[index] ?? null;
      noteUnusable(value, index, columns, warnings);
      return literal(value, column.jdbcTypeName);
    });
    return `  (${values.join(', ')})`;
  });
  return [
    header(request, tableName, rows.length),
    ...warnings.map((line) => `-- ${line}`),
    '',
    `INSERT INTO ${tableName} (${columnList}) VALUES`,
    `${tuples.join(',\n')};`,
    '',
  ].join('\n');
}

/**
 * One `UPDATE` for one row.
 *
 * With edits, only the edited columns are set - a statement that rewrites a column to the value it
 * already has is noise in a review. Without edits the whole row is written out, which is what "give me
 * the UPDATE for this row" means when somebody wants a starting point.
 */
function buildUpdateRow(
  request: BuildRequest,
  tableName: string,
  rowIndex: number,
  row: readonly SqlValue[],
  identity: readonly number[],
  predicate: string,
  warnings: string[],
): string {
  const { columns, changes, quote } = request;
  const edits = (changes ?? []).filter((change) => change.row === rowIndex);
  const edited = new Map(edits.map((change) => [change.column, change]));

  const settable =
    edits.length > 0
      ? columns.map((_, index) => index).filter((index) => edited.has(index))
      : columns.map((_, index) => index).filter((index) => !identity.includes(index));

  const assignments = settable.map((index) => {
    const column = columns[index];
    const change = edited.get(index);
    const value: SqlValue = change ? (change.isNull ? null : change.value) : (row[index] ?? null);
    if (!change) {
      noteUnusable(value, index, columns, warnings);
    }
    return `${quoteIdentifier(column.name, quote)} = ${literal(value, column.jdbcTypeName)}`;
  });

  return `-- row ${rowIndex + 1}\nUPDATE ${tableName} SET ${assignments.join(', ')} WHERE ${predicate};`;
}

/** `k = v AND k2 IS NULL`, or undefined when a value cannot be trusted. */
function rowPredicate(
  row: readonly SqlValue[],
  identity: readonly number[],
  columns: readonly StatementColumn[],
  quote?: string,
): string | undefined {
  const parts: string[] = [];
  for (const index of identity) {
    const column = columns[index];
    if (!column) {
      return undefined;
    }
    const value = row[index] ?? null;
    if (unusableReason(value) !== undefined) {
      return undefined;
    }
    const name = quoteIdentifier(column.name, quote);
    parts.push(value === null ? `${name} IS NULL` : `${name} = ${literal(value, column.jdbcTypeName)}`);
  }
  return parts.join(' AND ');
}

/** Records a warning once per column, for a value that cannot be written back faithfully. */
function noteUnusable(
  value: SqlValue,
  index: number,
  columns: readonly StatementColumn[],
  warnings: string[],
): void {
  const reason = unusableReason(value);
  if (reason === undefined) {
    return;
  }
  const name = columns[index]?.name ?? `#${index + 1}`;
  const line = t('{0}: {1}', name, reason);
  if (!warnings.includes(line)) {
    warnings.push(line);
  }
}

/**
 * A statement that counts what the original statement returns.
 *
 * A derived table rather than a rewritten `SELECT`: the count has to agree with what the grid shows,
 * and re-deriving the projection, joins and predicates from the user's SQL would mean parsing it. The
 * form is standard SQL; a database that rejects an `ORDER BY` inside a derived table will reject it
 * with a message about the statement the user can see.
 */
export function countStatement(sql: string): string | undefined {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(trimmed)) {
    return undefined;
  }
  return `SELECT COUNT(*) FROM (\n${trimmed}\n) open_dbclient_count;`;
}
