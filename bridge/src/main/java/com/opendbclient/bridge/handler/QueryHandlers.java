package com.opendbclient.bridge.handler;

import java.io.IOException;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import com.opendbclient.bridge.BridgeServices;
import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.pool.ConnectionPool;
import com.opendbclient.bridge.result.ActiveQuery;
import com.opendbclient.bridge.result.QueryResultStore;
import com.opendbclient.bridge.result.ResultColumn;
import com.opendbclient.bridge.result.RowReader;
import com.opendbclient.bridge.rpc.Protocol;
import com.opendbclient.bridge.rpc.RequestContext;
import com.opendbclient.bridge.rpc.RpcException;
import com.opendbclient.bridge.rpc.RpcServer;

/**
 * Query execution, paging and cancellation.
 *
 * <h2>One statement per request</h2>
 *
 * The extension splits a script into individual statements before sending them. That is not an
 * arbitrary division of labour: it means each statement gets its own result, its own error, and its
 * own timing, which is what a user running a script actually wants to see. It also avoids the
 * ambiguity of drivers that report only the last result of a multi-statement batch.
 *
 * <h2>Results are read once and spilled</h2>
 *
 * A statement's rows are consumed completely - up to a configurable ceiling - into a
 * {@link QueryResultStore} before the connection is returned to the pool. This keeps the connection
 * hold time proportional to reading the data rather than to how long the user browses it, and it
 * means the display never depends on a server-side cursor staying open.
 */
public final class QueryHandlers {

    /** How long to wait for a pooled connection before giving up. */
    private static final long BORROW_TIMEOUT_MILLIS = 60_000L;

    private static final int DEFAULT_PAGE_SIZE = 200;
    private static final int MAX_PAGE_SIZE = 10_000;

    /** Rows read before a result set is truncated when the caller does not say otherwise. */
    private static final int DEFAULT_MAX_ROWS = 100_000;

    /** How often to report progress while reading a large result. */
    private static final int PROGRESS_INTERVAL = 5_000;

    private QueryHandlers() {
    }

    public static void register(RpcServer server, BridgeServices services) {
        server.register(Protocol.QUERY_EXECUTE, (params, ctx) -> execute(services, params, ctx));
        server.register(Protocol.QUERY_FETCH, (params, ctx) -> fetch(services, params));
        server.register(Protocol.QUERY_CANCEL, (params, ctx) -> cancel(services, params));
        server.register(Protocol.QUERY_CLOSE, (params, ctx) -> release(services, params));
        server.register(Protocol.QUERY_LIST, (params, ctx) -> list(services));
    }

    // ------------------------------------------------------------------
    // execute
    // ------------------------------------------------------------------

    private static Map<String, Object> execute(
            BridgeServices services,
            Map<String, Object> params,
            RequestContext ctx) throws IOException, SQLException {

        String connectionId = Json.requireStr(params, "connectionId");
        String sql = Json.requireStr(params, "sql");
        int pageSize = clamp(Json.intValue(params, "pageSize", DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE);
        // Zero means "no ceiling", which a user can ask for deliberately.
        int maxRows = Math.max(0, Json.intValue(params, "maxRows", DEFAULT_MAX_ROWS));
        int fetchSize = Json.intValue(params, "fetchSize", 0);

        ConnectionPool pool = services.connections().require(connectionId);

        // Prefer an identifier supplied by the caller. The extension needs the id before execution
        // starts, otherwise a query that is still running cannot be named and therefore cannot be
        // cancelled - the identifier would only arrive with the result it was needed to abort.
        String queryId = Json.str(params, "queryId");
        if (queryId == null || queryId.isBlank()) {
            queryId = services.queries().nextQueryId();
        }

        ActiveQuery active = new ActiveQuery(queryId, connectionId, ctx);
        services.queries().beginRunning(active);

        long startNanos = System.nanoTime();
        try {
            Execution execution;
            Connection connection = pool.borrow(BORROW_TIMEOUT_MILLIS);
            try {
                execution = runStatement(connection, sql, active, maxRows, fetchSize);
            } catch (IOException failure) {
                // A disk problem is not a database problem, and reporting it as one would send the
                // user looking in the wrong place.
                throw new RpcException(Protocol.ERROR_IO,
                        "Could not store the query results: " + failure.getMessage(), null, 0, failure);
            } finally {
                // The connection is released only after every row has been read, so a slow consumer
                // never holds a database session open.
                pool.release(connection);
            }

            long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos);
            services.queries().recordCompletion(elapsedMillis, summarize(sql));

            if (!execution.hasResultSet()) {
                return Json.obj(
                        "queryId", queryId,
                        "hasResultSet", Boolean.FALSE,
                        "updateCount", execution.updateCount(),
                        "elapsedMillis", elapsedMillis);
            }

            QueryResultStore store = execution.store();
            services.queries().store(queryId, connectionId, store);
            QueryResultStore.Page page = store.fetch(0, pageSize);

            Map<String, Object> payload = Json.obj(
                    "queryId", queryId,
                    "hasResultSet", Boolean.TRUE,
                    "columns", columnsPayload(store.columns()),
                    "rows", new ArrayList<Object>(page.rows()),
                    "offset", page.offset(),
                    "totalRows", page.totalRows(),
                    "truncated", execution.truncated(),
                    "elapsedMillis", elapsedMillis);
            if (execution.truncated()) {
                payload.put("truncatedAt", maxRows);
            }
            return payload;
        } catch (Throwable failure) {
            services.queries().recordFailure();
            throw failure;
        } finally {
            services.queries().endRunning(queryId);
        }
    }

    /**
     * Executes one statement and drains its result set.
     *
     * <p>The statement is attached to the {@link ActiveQuery} before execution so a cancellation that
     * arrives while the database is still computing can reach {@code Statement.cancel()}. Attaching
     * afterwards would make a long-running statement uncancellable precisely when cancellation
     * matters most.
     */
    private static Execution runStatement(
            Connection connection,
            String sql,
            ActiveQuery active,
            int maxRows,
            int fetchSize) throws SQLException, IOException {

        Statement statement = connection.createStatement();
        active.attach(statement);
        try {
            if (fetchSize > 0) {
                try {
                    statement.setFetchSize(fetchSize);
                } catch (SQLException | RuntimeException failure) {
                    // Purely a performance hint; some drivers reject any value at all.
                    Log.debug("The driver refused a fetch size of %d: %s", fetchSize, failure.getMessage());
                }
            }

            if (!statement.execute(sql)) {
                return Execution.update(statement.getUpdateCount());
            }

            try (ResultSet rows = statement.getResultSet()) {
                List<ResultColumn> columns = ResultColumn.read(rows.getMetaData());
                QueryResultStore store = new QueryResultStore(active.queryId(), columns);

                long count = 0;
                boolean truncated = false;
                boolean completed = false;
                try {
                    while (rows.next()) {
                        if (active.isCancelled()) {
                            throw new RpcException(Protocol.ERROR_QUERY_CANCELLED, "the query was cancelled");
                        }
                        if (maxRows > 0 && count >= maxRows) {
                            truncated = true;
                            break;
                        }
                        store.appendRow(RowReader.read(rows, columns.size()));
                        count++;
                        if (count % PROGRESS_INTERVAL == 0) {
                            active.progress(count);
                        }
                    }
                    completed = true;
                } finally {
                    // Never leave a partially written result file behind for a query that failed.
                    if (!completed) {
                        store.close();
                    }
                }
                return Execution.rows(store, truncated);
            }
        } finally {
            active.detach();
            closeQuietly(statement);
        }
    }

    // ------------------------------------------------------------------
    // paging, cancellation, lifetime
    // ------------------------------------------------------------------

    private static Map<String, Object> fetch(BridgeServices services, Map<String, Object> params)
            throws IOException {
        String queryId = Json.requireStr(params, "queryId");
        int offset = Math.max(0, Json.intValue(params, "offset", 0));
        int limit = clamp(Json.intValue(params, "limit", DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE);

        QueryResultStore.Page page = services.queries().require(queryId).fetch(offset, limit);
        return Json.obj(
                "queryId", queryId,
                "offset", page.offset(),
                "rows", new ArrayList<Object>(page.rows()),
                "totalRows", page.totalRows());
    }

    private static Map<String, Object> cancel(BridgeServices services, Map<String, Object> params) {
        String queryId = Json.requireStr(params, "queryId");
        services.queries().cancel(queryId);
        return Json.obj("queryId", queryId, "cancelled", Boolean.TRUE);
    }

    private static Map<String, Object> release(BridgeServices services, Map<String, Object> params) {
        String queryId = Json.requireStr(params, "queryId");
        services.queries().release(queryId);
        return Json.obj("queryId", queryId, "closed", Boolean.TRUE);
    }

    private static Map<String, Object> list(BridgeServices services) {
        List<Object> results = new ArrayList<>(services.queries().resultsPayload());
        return Json.obj(
                "results", results,
                "running", services.queries().runningCount(),
                "metrics", services.queries().metricsPayload());
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private static List<Object> columnsPayload(List<ResultColumn> columns) {
        List<Object> payloads = new ArrayList<>(columns.size());
        for (ResultColumn column : columns) {
            payloads.add(column.toPayload());
        }
        return payloads;
    }

    /** Keeps the recorded slow-query summary to something that fits in a log line. */
    private static String summarize(String sql) {
        String collapsed = sql.replaceAll("\\s+", " ").trim();
        return collapsed.length() <= 160 ? collapsed : collapsed.substring(0, 160) + "...";
    }

    private static void closeQuietly(Statement statement) {
        try {
            statement.close();
        } catch (SQLException | RuntimeException failure) {
            Log.debug("Closing a statement failed: %s", failure.getMessage());
        }
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    /** Outcome of running one statement. */
    private record Execution(boolean hasResultSet, int updateCount, QueryResultStore store, boolean truncated) {

        static Execution update(int updateCount) {
            return new Execution(false, updateCount, null, false);
        }

        static Execution rows(QueryResultStore store, boolean truncated) {
            return new Execution(true, -1, store, truncated);
        }
    }
}
