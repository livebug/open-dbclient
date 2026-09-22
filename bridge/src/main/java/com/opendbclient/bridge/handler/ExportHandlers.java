package com.opendbclient.bridge.handler;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import com.opendbclient.bridge.BridgeServices;
import com.opendbclient.bridge.export.ExportService;
import com.opendbclient.bridge.export.ExportTarget;
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
 * Exports results to a file.
 *
 * <h2>Two sources, one writer</h2>
 *
 * An export can come from a result the user is already looking at, or from a query run purely to
 * export it. Both take the same path once the rows start flowing, so the file contains exactly what
 * the grid showed.
 *
 * <h2>No row ceiling</h2>
 *
 * Query execution caps how much it will hold in the display cache, but an export is the operation
 * where a user means "all of it" - asking for a table's contents and receiving a hundred thousand
 * rows without being told the rest was dropped would be the worst possible behaviour. Rows are
 * therefore streamed straight from the database into the writer, and memory stays flat regardless
 * of how much is exported.
 *
 * <h2>Re-execution is deliberate</h2>
 *
 * Exporting from a query id re-reads the spilled result rather than re-running the SQL. Exporting
 * from SQL runs it fresh. A result that has already been evicted falls back to nothing rather than
 * silently re-running a statement that may no longer return the same rows - the caller is told the
 * result is gone instead.
 */
public final class ExportHandlers {

    private static final long BORROW_TIMEOUT_MILLIS = 300_000L;
    private static final int STORED_PAGE_SIZE = 5_000;
    private static final int PROGRESS_INTERVAL = 10_000;

    private ExportHandlers() {
    }

    public static void register(RpcServer server, BridgeServices services) {
        server.register(Protocol.QUERY_EXPORT, (params, ctx) -> export(services, params, ctx));
    }

    private static Map<String, Object> export(
            BridgeServices services,
            Map<String, Object> params,
            RequestContext ctx) throws IOException, SQLException {

        String format = Json.requireStr(params, "format");
        String filePath = Json.requireStr(params, "filePath");
        String queryId = Json.str(params, "queryId");
        String sql = Json.str(params, "sql");
        Map<String, Object> options = Json.mapValue(params, "options");
        String tableName = Json.str(params, "tableName", null);

        if (queryId == null && sql == null) {
            throw RpcException.invalidParams("either 'queryId' or 'sql' must be supplied");
        }

        Path target = Path.of(filePath).toAbsolutePath().normalize();
        Path parent = target.getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }

        long startNanos = System.nanoTime();
        long exportedRows;
        try (ExportTarget exporter = ExportService.create(format, target, options, tableName)) {
            if (queryId != null) {
                exportedRows = exportStoredResult(services, queryId, exporter, ctx);
            } else {
                String connectionId = Json.requireStr(params, "connectionId");
                exportedRows = exportQuery(services, connectionId, sql, exporter, ctx);
            }
        } catch (IOException | SQLException | RuntimeException failure) {
            // A half-written export is worse than none: the user cannot tell whether the file is
            // complete, and will assume it is.
            deleteQuietly(target);
            throw failure;
        }

        long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos);
        long bytes = Files.exists(target) ? Files.size(target) : 0L;
        Log.info("Exported %d row(s) to %s (%d bytes, %d ms)", exportedRows, target, bytes, elapsedMillis);

        return Json.obj(
                "file", target.toString(),
                "format", format,
                "rows", exportedRows,
                "bytes", bytes,
                "elapsedMillis", elapsedMillis);
    }

    /** Streams a previously executed result out of its spill file. */
    private static long exportStoredResult(
            BridgeServices services,
            String queryId,
            ExportTarget exporter,
            RequestContext ctx) throws IOException {

        QueryResultStore store = services.queries().require(queryId);
        exporter.begin(store.columns());

        long exported = 0;
        int offset = 0;
        while (true) {
            QueryResultStore.Page page = store.fetch(offset, STORED_PAGE_SIZE);
            List<List<Object>> rows = page.rows();
            if (rows.isEmpty()) {
                break;
            }
            for (List<Object> row : rows) {
                if (ctx.isCancelled()) {
                    throw new RpcException(Protocol.ERROR_QUERY_CANCELLED, "the export was cancelled");
                }
                exporter.row(row);
                exported++;
            }
            offset += rows.size();
            if (offset % PROGRESS_INTERVAL < STORED_PAGE_SIZE) {
                ctx.progress(exported, page.totalRows());
            }
        }

        exporter.end();
        return exported;
    }

    /** Runs a statement and streams its rows straight into the writer. */
    private static long exportQuery(
            BridgeServices services,
            String connectionId,
            String sql,
            ExportTarget exporter,
            RequestContext ctx) throws SQLException, IOException {

        ConnectionPool pool = services.connections().require(connectionId);
        String queryId = services.queries().nextQueryId();
        ActiveQuery active = new ActiveQuery(queryId, connectionId, ctx);
        services.queries().beginRunning(active);

        try {
            Connection connection = pool.borrow(BORROW_TIMEOUT_MILLIS);
            try {
                return runExport(connection, sql, exporter, active);
            } finally {
                pool.release(connection);
            }
        } finally {
            services.queries().endRunning(queryId);
        }
    }

    private static long runExport(
            Connection connection,
            String sql,
            ExportTarget exporter,
            ActiveQuery active) throws SQLException, IOException {

        Statement statement = connection.createStatement();
        active.attach(statement);
        try {
            if (!statement.execute(sql)) {
                throw RpcException.invalidParams(
                        "the statement did not produce a result set, so there is nothing to export");
            }

            try (ResultSet rows = statement.getResultSet()) {
                List<ResultColumn> columns = ResultColumn.read(rows.getMetaData());
                exporter.begin(columns);

                long exported = 0;
                while (rows.next()) {
                    if (active.isCancelled()) {
                        throw new RpcException(Protocol.ERROR_QUERY_CANCELLED, "the export was cancelled");
                    }
                    exporter.row(RowReader.read(rows, columns.size()));
                    exported++;
                    if (exported % PROGRESS_INTERVAL == 0) {
                        active.progress(exported);
                    }
                }

                exporter.end();
                return exported;
            }
        } finally {
            active.detach();
            try {
                statement.close();
            } catch (SQLException | RuntimeException failure) {
                Log.debug("Closing the export statement failed: %s", failure.getMessage());
            }
        }
    }

    private static void deleteQuietly(Path target) {
        try {
            Files.deleteIfExists(target);
        } catch (IOException failure) {
            Log.debug("Could not remove the partial export %s: %s", target, failure.getMessage());
        }
    }
}
