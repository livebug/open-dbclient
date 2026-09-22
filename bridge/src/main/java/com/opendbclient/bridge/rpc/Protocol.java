package com.opendbclient.bridge.rpc;

/**
 * Wire-level constants for the bridge protocol.
 *
 * <p>Framing is newline-delimited JSON: exactly one JSON document per line, always
 * compact (no embedded newlines). Every payload is JSON-escaped, so a line break can
 * only ever mean "frame boundary".
 *
 * <p>Three frame shapes exist:
 * <pre>
 * request   {"id":"&lt;uuid&gt;","method":"query.execute","params":{...}}
 * response  {"id":"&lt;uuid&gt;","ok":true,"result":{...}}
 *           {"id":"&lt;uuid&gt;","ok":false,"error":{...}}
 * event     {"type":"event","method":"query.progress","params":{...}}
 * </pre>
 */
public final class Protocol {

    private Protocol() {
    }

    // ------------------------------------------------------------------
    // handshake & lifecycle
    // ------------------------------------------------------------------

    public static final String SYSTEM_PING = "system.ping";
    public static final String SYSTEM_INFO = "system.info";
    /** Applies process-wide settings, such as the result cache budget. */
    public static final String SYSTEM_CONFIGURE = "system.configure";
    public static final String SYSTEM_SHUTDOWN = "system.shutdown";

    // ------------------------------------------------------------------
    // drivers
    // ------------------------------------------------------------------

    public static final String DRIVER_LIST = "driver.list";
    public static final String DRIVER_REGISTER = "driver.register";
    public static final String DRIVER_UNREGISTER = "driver.unregister";

    // ------------------------------------------------------------------
    // connections
    // ------------------------------------------------------------------

    public static final String CONNECTION_OPEN = "connection.open";
    public static final String CONNECTION_TEST = "connection.test";
    public static final String CONNECTION_CLOSE = "connection.close";
    public static final String CONNECTION_LIST = "connection.list";

    // ------------------------------------------------------------------
    // metadata
    // ------------------------------------------------------------------

    public static final String METADATA_CAPABILITIES = "metadata.capabilities";
    public static final String METADATA_CATALOGS = "metadata.catalogs";
    public static final String METADATA_SCHEMAS = "metadata.schemas";
    /** Table-like objects, optionally filtered by {@code TABLE_TYPE}. */
    public static final String METADATA_TABLES = "metadata.tables";
    /** The {@code TABLE_TYPE} labels this driver actually uses, so callers need not guess. */
    public static final String METADATA_TABLE_TYPES = "metadata.tableTypes";
    public static final String METADATA_COLUMNS = "metadata.columns";
    public static final String METADATA_INDEXES = "metadata.indexes";
    public static final String METADATA_DDL = "metadata.ddl";

    // ------------------------------------------------------------------
    // queries
    // ------------------------------------------------------------------

    public static final String QUERY_EXECUTE = "query.execute";
    public static final String QUERY_FETCH = "query.fetch";
    public static final String QUERY_CANCEL = "query.cancel";
    public static final String QUERY_CLOSE = "query.close";
    public static final String QUERY_LIST = "query.list";
    public static final String QUERY_EXPORT = "query.export";

    // ------------------------------------------------------------------
    // health
    // ------------------------------------------------------------------

    public static final String HEALTH_SNAPSHOT = "health.snapshot";
    public static final String HEALTH_SUBSCRIBE = "health.subscribe";
    public static final String HEALTH_UNSUBSCRIBE = "health.unsubscribe";

    // ------------------------------------------------------------------
    // events pushed from bridge to extension
    // ------------------------------------------------------------------

    /** Periodic health metrics push, emitted while {@code health.subscribe} is active. */
    public static final String EVENT_HEALTH_METRICS = "health.metrics";

    /** Row-progress notification for a long-running export or fetch. */
    public static final String EVENT_QUERY_PROGRESS = "query.progress";

    /** Unsolicited log line, so bridge diagnostics can surface in the output channel. */
    public static final String EVENT_LOG = "log";

    /** Emitted once the bridge has finished wiring up handlers. */
    public static final String EVENT_READY = "bridge.ready";

    // ------------------------------------------------------------------
    // error codes
    // ------------------------------------------------------------------

    public static final String ERROR_PARSE = "PARSE_ERROR";
    public static final String ERROR_INVALID_PARAMS = "INVALID_PARAMS";
    public static final String ERROR_UNKNOWN_METHOD = "UNKNOWN_METHOD";
    public static final String ERROR_INTERNAL = "INTERNAL_ERROR";
    public static final String ERROR_DRIVER_NOT_FOUND = "DRIVER_NOT_FOUND";
    public static final String ERROR_DRIVER_LOAD_FAILED = "DRIVER_LOAD_FAILED";
    public static final String ERROR_CONNECTION_FAILED = "CONNECTION_FAILED";
    public static final String ERROR_CONNECTION_NOT_FOUND = "CONNECTION_NOT_FOUND";
    public static final String ERROR_SQL = "SQL_ERROR";
    public static final String ERROR_QUERY_CANCELLED = "QUERY_CANCELLED";
    public static final String ERROR_QUERY_NOT_FOUND = "QUERY_NOT_FOUND";
    public static final String ERROR_NOT_FOUND = "NOT_FOUND";
    public static final String ERROR_UNSUPPORTED = "UNSUPPORTED";
    public static final String ERROR_EXPORT_FAILED = "EXPORT_FAILED";
    public static final String ERROR_IO = "IO_ERROR";
}
