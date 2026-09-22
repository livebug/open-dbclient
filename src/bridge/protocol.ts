/**
 * The bridge wire protocol, mirrored from the Java side.
 *
 * Method names and payload shapes are duplicated deliberately rather than generated: the two
 * languages share no build step, and an explicit list is easier to audit than a code generator whose
 * output nobody reads. When a method is added on the Java side it must be added here too.
 */

/** Methods the extension can invoke. Mirrors `Protocol.java`. */
export const Methods = {
  // lifecycle
  ping: 'system.ping',
  info: 'system.info',
  systemConfigure: 'system.configure',
  shutdown: 'system.shutdown',

  // drivers
  driverList: 'driver.list',
  driverRegister: 'driver.register',
  driverUnregister: 'driver.unregister',

  // connections
  connectionOpen: 'connection.open',
  connectionTest: 'connection.test',
  connectionClose: 'connection.close',
  connectionList: 'connection.list',

  // metadata
  metadataCapabilities: 'metadata.capabilities',
  metadataCatalogs: 'metadata.catalogs',
  metadataSchemas: 'metadata.schemas',
  metadataTableTypes: 'metadata.tableTypes',
  metadataTables: 'metadata.tables',
  metadataColumns: 'metadata.columns',
  metadataIndexes: 'metadata.indexes',
  metadataDdl: 'metadata.ddl',

  // queries
  queryExecute: 'query.execute',
  queryFetch: 'query.fetch',
  queryCancel: 'query.cancel',
  queryClose: 'query.close',
  queryList: 'query.list',
  queryExport: 'query.export',

  // health
  healthSnapshot: 'health.snapshot',
  healthSubscribe: 'health.subscribe',
  healthUnsubscribe: 'health.unsubscribe',
} as const;

export type MethodName = (typeof Methods)[keyof typeof Methods];

/** Events the bridge pushes. Mirrors the `Protocol.EVENT_*` constants. */
export const Events = {
  ready: 'bridge.ready',
  log: 'log',
  queryProgress: 'query.progress',
  healthMetrics: 'health.metrics',
} as const;

/** Error codes the bridge reports. */
export const ErrorCodes = {
  parse: 'PARSE_ERROR',
  invalidParams: 'INVALID_PARAMS',
  unknownMethod: 'UNKNOWN_METHOD',
  internal: 'INTERNAL_ERROR',
  driverNotFound: 'DRIVER_NOT_FOUND',
  driverLoadFailed: 'DRIVER_LOAD_FAILED',
  connectionFailed: 'CONNECTION_FAILED',
  connectionNotFound: 'CONNECTION_NOT_FOUND',
  sql: 'SQL_ERROR',
  queryCancelled: 'QUERY_CANCELLED',
  queryNotFound: 'QUERY_NOT_FOUND',
  notFound: 'NOT_FOUND',
  unsupported: 'UNSUPPORTED',
  exportFailed: 'EXPORT_FAILED',
  io: 'IO_ERROR',
} as const;

// ---------------------------------------------------------------------------
// payloads
// ---------------------------------------------------------------------------

/** A JDBC driver the bridge can instantiate. */
export interface DriverInfo {
  driverClassName: string;
  displayName: string;
  version?: string;
  majorVersion: number;
  minorVersion: number;
  jdbcCompliant: boolean;
  sourceJar?: string;
}

export interface DriverFailure {
  jar?: string;
  driverClassName?: string;
  message: string;
}

export interface DriverRegistrationResult {
  jarPaths: string[];
  drivers: DriverInfo[];
  failures: DriverFailure[];
  /** Drivers whose backing jar changed; connections using them were closed. */
  staleDrivers: string[];
  requiresReconnect: boolean;
  closedConnections: string[];
}

export interface DriverListResult {
  jarPaths: string[];
  drivers: DriverInfo[];
  driverCount: number;
}

/**
 * Capability flags probed from `DatabaseMetaData`.
 *
 * This is the substitute for a dialect: the extension branches on what the database reports, never
 * on what brand it is.
 */
export interface DatabaseCapabilities {
  databaseProductName?: string;
  databaseProductVersion?: string;
  driverName?: string;
  driverVersion?: string;
  /** Quote character for identifiers, absent when the database cannot quote them at all. */
  identifierQuoteString?: string;
  catalogTerm?: string;
  schemaTerm?: string;
  catalogSeparator?: string;
  supportsCatalogs: boolean;
  supportsSchemas: boolean;
  storesUpperCaseIdentifiers: boolean;
  storesLowerCaseIdentifiers: boolean;
  storesMixedCaseIdentifiers: boolean;
  supportsMixedCaseQuotedIdentifiers: boolean;
  maxColumnNameLength: number;
  maxTableNameLength: number;
  supportsTransactions: boolean;
  supportsBatchUpdates: boolean;
  supportsSavepoints: boolean;
  supportsGetGeneratedKeys: boolean;
  supportsMultipleResultSets: boolean;
  supportsStoredProcedures: boolean;
  readOnly: boolean;
  /** Human-readable one-liner, e.g. `"SQLite 3.47.1 via SQLite JDBC 3.47.1.0"`. */
  description: string;
}

export interface ProbeResult {
  connectionId: string;
  driverClassName: string;
  connectMillis: number;
  capabilities: DatabaseCapabilities;
}

export interface TableInfo {
  name: string;
  /** The `TABLE_TYPE` label the driver used, e.g. `TABLE`, `VIEW`, `SYSTEM TABLE`. */
  type: string;
  catalog?: string;
  schema?: string;
  remarks?: string;
}

export interface ColumnInfo {
  name: string;
  typeName: string;
  /** Type with its length rendered in, e.g. `varchar(255)`. Computed by the bridge. */
  displayType: string;
  jdbcType: number;
  jdbcTypeName: string;
  size: number;
  decimalDigits?: number;
  nullable: boolean;
  nullableKnown: boolean;
  defaultValue?: string;
  remarks?: string;
  ordinal: number;
  primaryKey: boolean;
  autoIncrement: boolean;
  generated: boolean;
  columnDefinition?: string;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  type: number;
  typeName: string;
  ordinal: number;
  columnName?: string;
  ascending?: boolean;
  cardinality?: number;
}

/** Live counters for one connection pool. */
export interface PoolStats {
  profileId: string;
  maxSize: number;
  total: number;
  active: number;
  idle: number;
  waiting: number;
  created: number;
  destroyed: number;
  borrowed: number;
  borrowTimeouts: number;
  validationFailures: number;
  connectFailures: number;
  totalBorrowWaitMillis: number;
  maxBorrowWaitMillis: number;
  averageBorrowWaitMillis: number;
  utilisation: number;
  closed: boolean;
}

/** A connection the bridge currently holds open. */
export interface ConnectionSummary {
  connectionId: string;
  driverClassName: string;
  url: string;
  user?: string;
  uptimeMillis: number;
  idleMillis: number;
  capabilities: DatabaseCapabilities;
  pool: PoolStats;
}

/** JVM and bridge process facts, from `system.info`. */
export interface BridgeInfo {
  version: string;
  pid: number;
  javaVersion: string;
  javaVendor: string;
  javaHome: string;
  osName: string;
  osArch: string;
  defaultEncoding: string;
  maxHeapBytes: number;
  totalHeapBytes: number;
  freeHeapBytes: number;
  uptimeMillis: number;
  handlers: number;
  requestsHandled: number;
  requestFailures: number;
  activeRequests: number;
}

/** A column of a query result, read from `ResultSetMetaData`. */
export interface ResultColumnInfo {
  name: string;
  label: string;
  typeName: string;
  /** Type with its length rendered in, e.g. `varchar(255)`. Computed by the bridge. */
  displayType: string;
  jdbcType: number;
  jdbcTypeName: string;
  nullable: boolean;
  tableName?: string;
  schemaName?: string;
}

/**
 * A cell value as it crosses the protocol.
 *
 * Numbers that could not survive a round trip through an IEEE-754 double arrive as strings, so a
 * consumer must treat the two as interchangeable when displaying or exporting.
 */
export type CellValue = string | number | boolean | null | CellValue[];

export interface QueryExecuteResult {
  queryId: string;
  hasResultSet: boolean;
  columns?: ResultColumnInfo[];
  rows?: CellValue[][];
  offset?: number;
  totalRows?: number;
  /** True when reading stopped at the row ceiling rather than at the end of the data. */
  truncated?: boolean;
  truncatedAt?: number;
  /** Rows affected, for a statement that returned no result set. */
  updateCount?: number;
  elapsedMillis: number;
}

export interface QueryFetchResult {
  queryId: string;
  offset: number;
  rows: CellValue[][];
  totalRows: number;
}

export interface QueryExportResult {
  file: string;
  format: string;
  rows: number;
  bytes: number;
  elapsedMillis: number;
}

export interface ProcessorUsage {
  heapUsed: number;
  heapCommitted: number;
  heapMax: number;
  heapUsedPercent: number;
  nonHeapUsed: number;
  nonHeapCommitted: number;
  metaspaceUsed: number;
}

/** Metrics for one connection pool, as pushed by the health subscription. */
export interface PoolSummary {
  connectionId: string;
  maxSize: number;
  total: number;
  active: number;
  idle: number;
  waiting: number;
  borrowed: number;
  borrowTimeouts: number;
  validationFailures: number;
  connectFailures: number;
  averageBorrowWaitMillis: number;
  utilisation: number;
  closed: boolean;
}

/** One spilled result held by the bridge. */
export interface CachedResultSummary {
  queryId: string;
  connectionId: string | null;
  rows: number;
  bytes: number;
  columns: number;
  ageMillis: number;
  idleMillis: number;
}

/**
 * A point-in-time view of the bridge's operational state.
 *
 * Everything describes the JDBC layer and the bridge process. There are deliberately no database-side
 * figures - buffer pool hit rates and the like - because reaching those needs vendor-specific SQL,
 * which this project exists without.
 */
export interface HealthSnapshot {
  timestamp: number;
  uptimeMillis: number;
  memory: ProcessorUsage;
  garbageCollector: {
    collections: number;
    collectionTimeMillis: number;
    collectionTimePercent: number;
    collectors: { name: string; collections: number; collectionTimeMillis: number }[];
  };
  threads: { count: number; peak: number; daemon: number };
  server: {
    requestsHandled: number;
    requestFailures: number;
    activeRequests: number;
    handlers: number;
  };
  connections?: ConnectionSummary[];
  connectionCount: number;
  /** Compact per-connection totals; present on every push, unlike `connections`. */
  poolSummaries: PoolSummary[];
  cache: {
    storedResults: number;
    cachedBytes: number;
    maxCacheBytes: number;
    results: CachedResultSummary[];
  };
  queries: {
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    storedResults: number;
    cachedBytes: number;
    maxCacheBytes: number;
    averageMillis: number;
    slowestMillis: number;
    slowestQuery?: string;
  };
}

/** Parses a duration into a compact, human-readable form. */
export function formatUptime(millis: number): string {
  const seconds = Math.floor(millis / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Parameters for opening or testing a connection.
 *
 * Deliberately has no database type field: a profile is a driver class name plus a URL plus
 * credentials, which is everything the extension needs to reach a database it knows nothing about.
 */
export interface ConnectionProfileParams extends Record<string, unknown> {
  connectionId: string;
  driverClassName: string;
  url: string;
  user?: string;
  password?: string;
  properties?: Record<string, string>;
  poolSize?: number;
  connectTimeoutSeconds?: number;
  validationTimeoutSeconds?: number;
  maxLifetimeSeconds?: number;
  idleTimeoutSeconds?: number;
}
