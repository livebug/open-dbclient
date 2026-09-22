/**
 * Identifiers shared across the extension.
 *
 * Everything the user can invoke or configure is named here once. Command ids in particular must
 * match `package.json` exactly; duplicating them as string literals is how a menu item quietly
 * stops working.
 */

export const EXTENSION_ID = 'open-dbclient';

/** Activity bar container contributed in `package.json`. */
export const CONTAINER_ID = EXTENSION_ID;

export const VIEW_CONNECTIONS = `${EXTENSION_ID}.connections`;
export const VIEW_HISTORY = `${EXTENSION_ID}.history`;

export const OUTPUT_CHANNEL_NAME = 'DB Client';

export const Commands = {
  // connections
  addConnection: `${EXTENSION_ID}.addConnection`,
  editConnection: `${EXTENSION_ID}.editConnection`,
  duplicateConnection: `${EXTENSION_ID}.duplicateConnection`,
  deleteConnection: `${EXTENSION_ID}.deleteConnection`,
  testConnection: `${EXTENSION_ID}.testConnection`,
  connect: `${EXTENSION_ID}.connect`,
  disconnect: `${EXTENSION_ID}.disconnect`,
  selectConnection: `${EXTENSION_ID}.selectConnection`,
  refreshNode: `${EXTENSION_ID}.refreshNode`,
  refreshAll: `${EXTENSION_ID}.refreshAll`,
  copyName: `${EXTENSION_ID}.copyName`,

  // queries
  openQuery: `${EXTENSION_ID}.openQuery`,
  runQuery: `${EXTENSION_ID}.runQuery`,
  runAllQueries: `${EXTENSION_ID}.runAllQueries`,
  runQueryFromTree: `${EXTENSION_ID}.runQueryFromTree`,
  cancelQuery: `${EXTENSION_ID}.cancelQuery`,
  insertHistoryEntry: `${EXTENSION_ID}.insertHistoryEntry`,
  deleteHistoryEntry: `${EXTENSION_ID}.deleteHistoryEntry`,
  clearHistory: `${EXTENSION_ID}.clearHistory`,

  // results
  exportResult: `${EXTENSION_ID}.exportResult`,
  exportTable: `${EXTENSION_ID}.exportTable`,

  // schema
  viewColumns: `${EXTENSION_ID}.viewColumns`,
  viewIndexes: `${EXTENSION_ID}.viewIndexes`,
  generateDdl: `${EXTENSION_ID}.generateDdl`,

  // drivers
  addDriverJar: `${EXTENSION_ID}.addDriverJar`,
  openDriverFolder: `${EXTENSION_ID}.openDriverFolder`,
  downloadDriver: `${EXTENSION_ID}.downloadDriver`,
  listDrivers: `${EXTENSION_ID}.listDrivers`,
  restartBridge: `${EXTENSION_ID}.restartBridge`,

  // introspection
  showHealth: `${EXTENSION_ID}.showHealth`,
  refreshMetadataCache: `${EXTENSION_ID}.refreshMetadataCache`,
} as const;

export type CommandId = (typeof Commands)[keyof typeof Commands];

/**
 * Context keys the extension sets so `when` clauses can react.
 *
 * `hasActiveConnection` gates the run-query keybindings; without it, Ctrl+Enter in a SQL file that
 * is not attached to a database would do nothing at all instead of nothing visible.
 */
export const ContextKeys = {
  hasActiveConnection: `${EXTENSION_ID}.hasActiveConnection`,
  bridgeReady: `${EXTENSION_ID}.bridgeReady`,
  hasDrivers: `${EXTENSION_ID}.hasDrivers`,
} as const;

/** Settings, with the `open-dbclient.` prefix applied once. */
export const Config = {
  javaHome: `${EXTENSION_ID}.javaHome`,
  javaArgs: `${EXTENSION_ID}.javaArgs`,
  jvmMaxHeap: `${EXTENSION_ID}.jvmMaxHeap`,
  driverPaths: `${EXTENSION_ID}.driverPaths`,
  driverClassNames: `${EXTENSION_ID}.driverClassNames`,
  poolSize: `${EXTENSION_ID}.connection.poolSize`,
  fetchSize: `${EXTENSION_ID}.query.fetchSize`,
  confirmDangerous: `${EXTENSION_ID}.query.confirmDangerous`,
  resultMaxCacheBytes: `${EXTENSION_ID}.result.maxCacheBytes`,
  intellisenseEnabled: `${EXTENSION_ID}.intellisense.enabled`,
  intellisensePrefetchTables: `${EXTENSION_ID}.intellisense.prefetchTables`,
  intellisenseColumnCacheLimit: `${EXTENSION_ID}.intellisense.columnCacheLimit`,
  healthEnabled: `${EXTENSION_ID}.health.enabled`,
  healthRefreshInterval: `${EXTENSION_ID}.health.refreshInterval`,
  healthShowStatusBar: `${EXTENSION_ID}.health.showStatusBar`,
  csvDelimiter: `${EXTENSION_ID}.export.csv.delimiter`,
  csvWriteBom: `${EXTENSION_ID}.export.csv.writeBom`,
  excelMaxRowsPerSheet: `${EXTENSION_ID}.export.excel.maxRowsPerSheet`,
  includeHeader: `${EXTENSION_ID}.export.includeHeader`,
  logLevel: `${EXTENSION_ID}.logLevel`,
} as const;

/** URI scheme for read-only documents the extension generates (DDL, column listings). */
export const VIRTUAL_DOCUMENT_SCHEME = 'open-dbclient';

/** Minimum Java major version the bridge requires. */
export const MINIMUM_JAVA_VERSION = 17;

/**
 * Directive used to attach a SQL file to a connection.
 *
 * Stored in the file itself rather than in workspace state so the binding survives a reload, works
 * when the file is shared, and is visible to the reader instead of being invisible editor state.
 */
export const CONNECTION_DIRECTIVE = /^[ \t]*--[ \t]*@connection[ \t]+(.+?)[ \t]*$/m;
