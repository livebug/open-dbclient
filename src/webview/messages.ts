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
}

/** A cell value. Mirrors what the bridge produces: never an object except for SQL arrays. */
export type GridValue = string | number | boolean | null | readonly GridValue[];

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
  | { readonly type: 'pageError'; readonly message: string };

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
  /** A grid-side failure worth surfacing, e.g. a failed clipboard write. */
  | { readonly type: 'report'; readonly message: string };

/** Rows the grid requests per page. Kept here so both sides agree on the default. */
export const DEFAULT_PAGE_SIZE = 200;
