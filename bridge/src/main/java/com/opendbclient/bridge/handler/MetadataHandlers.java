package com.opendbclient.bridge.handler;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

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
            return withConnection(services, connectionId, connection -> Json.obj(
                    "catalogs", new ArrayList<Object>(MetadataProvider.catalogs(connection))));
        });

        server.register(Protocol.METADATA_SCHEMAS, (params, ctx) -> {
            String connectionId = Json.requireStr(params, "connectionId");
            String catalog = optional(params, "catalog");
            return withConnection(services, connectionId, connection -> Json.obj(
                    "catalog", catalog,
                    "schemas", new ArrayList<Object>(MetadataProvider.schemas(connection, catalog))));
        });

        server.register(Protocol.METADATA_TABLE_TYPES, (params, ctx) -> {
            String connectionId = Json.requireStr(params, "connectionId");
            return withConnection(services, connectionId, connection -> Json.obj(
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

            return withConnection(services, connectionId, connection -> {
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

            return withConnection(services, connectionId, connection -> {
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

            return withConnection(services, connectionId, connection -> {
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

            return withConnection(services, connectionId, connection ->
                    Json.obj(
                            "table", table,
                            "schema", schema,
                            "ddl", DdlBuilder.createTable(connection, catalog, schema, table)));
        });
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /**
     * Runs a metadata action against a pooled connection.
     *
     * <p>Using the pool's borrow/release pair rather than a raw connection keeps this path subject
     * to the same timeouts and health accounting as every other request.
     */
    private static Object withConnection(
            BridgeServices services,
            String connectionId,
            ConnectionPool.SqlAction<Object> action) throws SQLException {
        return services.connections().require(connectionId).withConnection(BORROW_TIMEOUT_MILLIS, action);
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
