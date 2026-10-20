/**
 * Message contract between the extension host and the result webview.
 *
 * Both sides import these types, so a change to the shape of a payload is a compile error on the
 * side that has not been updated. A webview talking to its host over untyped `postMessage` calls is
 * otherwise a silent-failure machine: nothing complains until a user notices a blank panel.
 */

/** A result column, as the grid needs it. */
export interface GridColumn {
  readonly name: string;
  readonly label: string;
  readonly displayType: string;
  readonly jdbcTypeName: string;
  readonly tableName?: string;
  /** Catalog and schema the column was read from, when the driver reported them: a statement the
   * grid generates has to name the table the same way the database does. */
  readonly schemaName?: string;
  readonly catalogName?: string;
  /** The column's comment, shown beside the name when the database documents the column. */
  readonly remarks?: string;
}

/** A cell value. Mirrors what the bridge produces: never an object except for SQL arrays. */
export type GridValue = string | number | boolean | null | readonly GridValue[];

/** One edit a user made in the grid, before it becomes part of a statement. */
export interface GridCellEdit {
  /** Index into the row's values. */
  readonly column: number;
  /** The text typed. Ignored when `isNull` is true. */
  readonly value: string;
  /** True when the user asked for NULL rather than for an empty string. */
  readonly isNull: boolean;
}

/**
 * One row handed to the host for statement generation.
 *
 * `original` and `changes` are kept apart rather than sending one merged row: an edited identity
 * column has to appear in the `SET` list with its new value while the `WHERE` still matches the value
 * the row actually has. Merging them would silently generate a statement that updates nothing.
 */
export interface GridRowForSql {
  readonly original: readonly GridValue[];
  readonly changes?: readonly GridCellEdit[];
}

export type GridStatementKind = 'insert' | 'update' | 'delete';

export type HostToWebviewMessage =
  /** A result set is ready to display. */
  | {
      readonly type: 'result';
      readonly sql: string;
      readonly connectionName: string;
      readonly columns: readonly GridColumn[];
      readonly rows: readonly (readonly GridValue[])[];
      readonly offset: number;
      readonly totalRows: number;
      readonly truncated: boolean;
      readonly truncatedAt?: number;
      readonly pageSize: number;
      readonly elapsedMillis: number;
    }
  /** A statement ran but produced no result set, e.g. an INSERT. */
  | {
      readonly type: 'update';
      readonly sql: string;
      readonly connectionName: string;
      readonly updateCount: number;
      readonly elapsedMillis: number;
    }
  /** A statement failed. */
  | {
      readonly type: 'error';
      readonly sql: string;
      readonly connectionName: string;
      readonly message: string;
      readonly sqlState?: string;
      readonly code: string;
    }
  /** The run started, so the panel can show that something is happening. */
  | { readonly type: 'running'; readonly sql: string; readonly connectionName: string }
  /** A different page of the current result arrived. */
  | {
      readonly type: 'page';
      readonly rows: readonly (readonly GridValue[])[];
      readonly offset: number;
      readonly totalRows: number;
    }
  /** The grid asked for a page and the bridge could not supply it. */
  | { readonly type: 'pageError'; readonly message: string }
  /** The user asked for the statement that would reproduce the selected rows. */
  | {
      readonly type: 'sqlReady';
      readonly kind: GridStatementKind;
      /** How many statements were written, for a one-line confirmation in the panel. */
      readonly statements: number;
      /** Values that could not be written back faithfully, or rows that were skipped. */
      readonly warnings: readonly string[];
    }
  /** The host could not write the statement, and says why. */
  | { readonly type: 'sqlFailed'; readonly message: string }
  /** The total the user asked for, once the count has run. */
  | { readonly type: 'totalCount'; readonly total: number }
  /** Counting failed, or the statement is not one that can be counted. */
  | { readonly type: 'countFailed'; readonly message: string }
  /** Which columns identify a row, once the host has resolved or been told them. */
  | { readonly type: 'identityColumns'; readonly columns: readonly string[] }
  /** A one-line note for the panel that is not a result, e.g. which columns now identify a row. */
  | { readonly type: 'notice'; readonly message: string };

export type WebviewToHostMessage =
  /** The DOM is ready; the host should send the pending content. */
  | { readonly type: 'ready' }
  /** The user navigated, so a page is wanted. */
  | { readonly type: 'requestPage'; readonly offset: number; readonly limit: number }
  /** The user asked to export the current result. */
  | { readonly type: 'export' }
  /** The user asked to run the statement again. */
  | { readonly type: 'rerun' }
  /** The user asked to cancel a running statement. */
  | { readonly type: 'cancel' }
  /** The user asked for the SQL that would write these rows back. */
  | {
      readonly type: 'generateSql';
      readonly kind: GridStatementKind;
      readonly rows: readonly GridRowForSql[];
    }
  /** The user asked what the whole result amounts to, beyond the page the grid holds. */
  | { readonly type: 'countRows' }
  /** The user asked to see or change which columns identify a row. */
  | { readonly type: 'chooseIdentityColumns' }
  /** A grid-side failure worth surfacing, e.g. a failed clipboard write. */
  | { readonly type: 'report'; readonly message: string };

/** Rows the grid requests per page. Kept here so both sides agree on the default. */
export const DEFAULT_PAGE_SIZE = 200;
