package com.opendbclient.bridge.handler;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import com.opendbclient.bridge.BridgeServices;
import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.metadata.ColumnInfo;
import com.opendbclient.bridge.metadata.DdlBuilder;
import com.opendbclient.bridge.metadata.IndexInfo;
import com.opendbclient.bridge.metadata.MetadataProvider;
import com.opendbclient.bridge.metadata.TableInfo;
import com.opendbclient.bridge.pool.ConnectionPool;
import com.opendbclient.bridge.rpc.Protocol;
import com.opendbclient.bridge.rpc.RpcServer;

/**
 * Schema introspection: catalogs, schemas, tables, columns, indexes and DDL.
 *
 * <p>All of it is answered from {@link DatabaseMetaData}. There is no per-database SQL anywhere in
 * this path, which is what allows the extension to work against a database it has never been taught
 * about.
 */
public final class MetadataHandlers {

    /**
     * How long a metadata request waits for a pooled connection.
     *
     * Generous compared with the interactive fetch timeout: introspection on a database with
     * thousands of tables can legitimately take a while, and the alternative to waiting is a
     * spurious failure.
     */
    private static final long BORROW_TIMEOUT_MILLIS = 30_000L;

    private MetadataHandlers() {
    }

    public static void register(RpcServer server, BridgeServices services) {
        server.register(Protocol.METADATA_CAPABILITIES, (params, ctx) -> {
            String connectionId = Json.requireStr(params, "connectionId");
            return services.connections().capabilities(connectionId).toPayload();
        });

        server.register(Protocol.METADATA_CATALOGS, (params, ctx) -> {
            String connectionId = Json.requireStr(params, "connectionId");
            return withConnection(services, connectionId, "catalogs", "", connection -> Json.obj(
                    "catalogs", new ArrayList<Object>(MetadataProvider.catalogs(connection))));
        });

        server.register(Protocol.METADATA_SCHEMAS, (params, ctx) -> {
            String connectionId = Json.requireStr(params, "connectionId");
            String catalog = optional(params, "catalog");
            return withConnection(services, connectionId, "schemas", catalog, connection -> Json.obj(
                    "catalog", catalog,
                    "schemas", new ArrayList<Object>(MetadataProvider.schemas(connection, catalog))));
        });

        server.register(Protocol.METADATA_TABLE_TYPES, (params, ctx) -> {
            String connectionId = Json.requireStr(params, "connectionId");
            return withConnection(services, connectionId, "tableTypes", "", connection -> Json.obj(
                    "tableTypes", new ArrayList<Object>(MetadataProvider.tableTypes(connection))));
        });

        server.register(Protocol.METADATA_TABLES, (params, ctx) -> {
            String connectionId = Json.requireStr(params, "connectionId");
            String catalog = optional(params, "catalog");
            String schema = optional(params, "schema");
            String namePattern = Json.str(params, "namePattern", "%");
            List<String> requestedTypes = Json.stringList(params, "types");

            // No type filter means "everything the driver considers table-like". Filtering by a
            // hard-coded list would hide objects on databases that use non-standard labels -
            // BASE TABLE, MANAGED_TABLE, EXTERNAL_TABLE - and the caller can group by the type it
            // gets back instead.
            String[] types = requestedTypes.isEmpty()
                    ? null
                    : requestedTypes.toArray(String[]::new);

            return withConnection(services, connectionId, "tables", qualified(catalog, schema), connection -> {
                List<TableInfo> tables = MetadataProvider.tables(
                        connection, catalog, schema, namePattern, types);
                List<Object> payloads = new ArrayList<>(tables.size());
                for (TableInfo table : tables) {
                    payloads.add(table.toPayload());
                }
                return Json.obj(
                        "catalog", catalog,
                        "schema", schema,
                        "tables", payloads,
                        "count", payloads.size());
            });
        });

        server.register(Protocol.METADATA_COLUMNS, (params, ctx) -> {
            String connectionId = Json.requireStr(params, "connectionId");
            String catalog = optional(params, "catalog");
            String schema = optional(params, "schema");
            String table = Json.requireStr(params, "table");

            // The object goes in the subject: "columns" taking twelve seconds is only actionable once it
            // says which table's columns.
            return withConnection(services, connectionId, "columns", qualified(schema, table), connection -> {
                List<ColumnInfo> columns = MetadataProvider.columns(connection, catalog, schema, table);
                List<Object> payloads = new ArrayList<>(columns.size());
                for (ColumnInfo column : columns) {
                    payloads.add(column.toPayload());
                }
                return Json.obj("table", table, "columns", payloads, "count", payloads.size());
            });
        });

        server.register(Protocol.METADATA_INDEXES, (params, ctx) -> {
            String connectionId = Json.requireStr(params, "connectionId");
            String catalog = optional(params, "catalog");
            String schema = optional(params, "schema");
            String table = Json.requireStr(params, "table");

            return withConnection(services, connectionId, "indexes", qualified(schema, table), connection -> {
                List<IndexInfo> indexes = MetadataProvider.indexes(connection, catalog, schema, table);
                List<Object> payloads = new ArrayList<>(indexes.size());
                for (IndexInfo index : indexes) {
                    payloads.add(index.toPayload());
                }
                return Json.obj("table", table, "indexes", payloads, "count", payloads.size());
            });
        });

        server.register(Protocol.METADATA_DDL, (params, ctx) -> {
            String connectionId = Json.requireStr(params, "connectionId");
            String catalog = optional(params, "catalog");
            String schema = optional(params, "schema");
            String table = Json.requireStr(params, "table");

            // Presentation only; the statement is still derived entirely from JDBC metadata.
            DdlBuilder.Options options = DdlBuilder.Options.from(Json.mapValue(params, "options"));

            return withConnection(services, connectionId, "ddl", qualified(schema, table), connection ->
                    Json.obj(
                            "table", table,
                            "schema", schema,
                            "ddl", DdlBuilder.createTable(connection, catalog, schema, table, options)));
        });
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /**
     * Runs a metadata action against a pooled connection, and records what it cost.
     *
     * <p>Using the pool's borrow/release pair rather than a raw connection keeps this path subject
     * to the same timeouts and health accounting as every other request.
     *
     * <p>Timed here rather than inside {@link MetadataProvider} because this is the boundary: the number
     * includes waiting for a pooled connection and reading whatever the driver had to read, which is the
     * number a user comparing two databases is asking about. Every read goes through this one method, so a
     * new one cannot be added without being measured.
     */
    private static Object withConnection(
            BridgeServices services,
            String connectionId,
            String call,
            String subject,
            ConnectionPool.SqlAction<Object> action) throws SQLException {

        long startNanos = System.nanoTime();
        try {
            Object payload = services.connections().require(connectionId)
                    .withConnection(BORROW_TIMEOUT_MILLIS, action);
            services.metadata().record(
                    connectionId,
                    call,
                    subject,
                    TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos),
                    true);
            return payload;
        } catch (SQLException | RuntimeException failure) {
            services.metadata().record(
                    connectionId,
                    call,
                    subject,
                    TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos),
                    false);
            throw failure;
        }
    }

    /** `schema.table`, or whichever of the two there is. Only used to name a call in the metrics. */
    private static String qualified(String first, String second) {
        if (first == null || first.isBlank()) {
            return second == null ? "" : second;
        }
        return second == null || second.isBlank() ? first : first + '.' + second;
    }

    /**
     * Reads the wire convention for "no filter".
     *
     * <p>An absent key and a blank string both mean "any", which JDBC expresses as a null argument.
     * Passing an empty string through instead would ask the driver for objects with an <em>empty</em>
     * schema name - a real, and usually empty, result set.
     */
    private static String optional(Map<String, Object> params, String key) {
        String value = Json.str(params, key);
        return value == null || value.isBlank() ? null : value;
    }
}
