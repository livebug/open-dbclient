package com.opendbclient.bridge.metadata;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import com.opendbclient.bridge.conn.MetadataSupport;
import com.opendbclient.bridge.log.Log;

/**
 * Reads schema structure using nothing but {@link DatabaseMetaData}.
 *
 * <p>This class is the whole reason the project has no dialect layer. Rather than knowing that
 * MySQL keeps its schema in {@code information_schema.columns} while PostgreSQL prefers
 * {@code pg_catalog}, it asks the driver through the standard interface and lets each driver
 * answer in whatever way it likes.
 *
 * <p>Two details here are subtle enough to be worth stating.
 *
 * <h2>Table and column names are LIKE patterns</h2>
 *
 * {@code getTables} and {@code getColumns} take <em>patterns</em>, not literal names. Passing a
 * table name through unchanged makes {@code _} match any single character, so a lookup for
 * {@code user_account} also matches {@code userXaccount}. Since underscores are everywhere in real
 * schemas, names are escaped with the driver's own escape character before being used.
 *
 * <h2>Result set columns may not exist</h2>
 *
 * The specification defines the columns each metadata query returns, but drivers omit them freely -
 * {@code IS_AUTOINCREMENT} is a frequent casualty. Every read goes through a safe accessor so a
 * missing column degrades one field rather than failing the whole listing.
 */
public final class MetadataProvider {

    private MetadataProvider() {
    }

    // ------------------------------------------------------------------
    // top level structure
    // ------------------------------------------------------------------

    /**
     * Catalogs the connection can see.
     *
     * <p>Many databases have no catalog concept and either return nothing or reject the call
     * outright; both cases yield an empty list, because a tree built on schemas alone is perfectly
     * usable.
     */
    public static List<String> catalogs(Connection connection) throws SQLException {
        DatabaseMetaData meta = connection.getMetaData();
        List<String> result = new ArrayList<>();
        try (ResultSet rows = meta.getCatalogs()) {
            while (rows.next()) {
                String name = safeString(rows, "TABLE_CAT");
                if (name != null && !name.isEmpty()) {
                    result.add(name);
                }
            }
        } catch (SQLException | RuntimeException failure) {
            Log.debug("catalogs are unavailable: %s", failure.getMessage());
        }
        return result;
    }

    /**
     * Schemas the connection can see, optionally narrowed to one catalog.
     *
     * @param catalog catalog to restrict to, or {@code null} for all catalogs
     */
    public static List<String> schemas(Connection connection, String catalog) throws SQLException {
        DatabaseMetaData meta = connection.getMetaData();
        List<String> result = new ArrayList<>();
        try (ResultSet rows = catalog == null ? meta.getSchemas() : meta.getSchemas(catalog, null)) {
            while (rows.next()) {
                String name = safeString(rows, "TABLE_SCHEM");
                if (name != null && !name.isEmpty()) {
                    result.add(name);
                }
            }
        } catch (SQLException | RuntimeException failure) {
            // SQL Server, for one, throws here rather than returning an empty set.
            Log.debug("schemas are unavailable for catalog %s: %s", catalog, failure.getMessage());
        }
        return result;
    }

    /**
     * Table-like objects matching a pattern.
     *
     * @param catalog     catalog to search, or {@code null} for any
     * @param schema      schema to search, or {@code null} for any
     * @param namePattern LIKE pattern for the object name; {@code "%"} means everything. This is
     *                    <em>not</em> escaped, because the caller is deliberately supplying a
     *                    pattern rather than a literal name
     * @param types       {@code TABLE_TYPE} values to include, or {@code null} for all
     */
    public static List<TableInfo> tables(
            Connection connection,
            String catalog,
            String schema,
            String namePattern,
            String[] types) throws SQLException {

        DatabaseMetaData meta = connection.getMetaData();
        List<TableInfo> result = new ArrayList<>();

        try (ResultSet rows = meta.getTables(catalog, schema, namePattern, types)) {
            while (rows.next()) {
                String name = safeString(rows, "TABLE_NAME");
                if (name == null || name.isEmpty()) {
                    continue;
                }
                result.add(new TableInfo(
                        safeString(rows, "TABLE_CAT"),
                        safeString(rows, "TABLE_SCHEM"),
                        name,
                        safeString(rows, "TABLE_TYPE"),
                        safeString(rows, "REMARKS")));
            }
        }
        return result;
    }

    /**
     * Columns of one table, in ordinal order.
     *
     * <p>Primary key membership is resolved with a second metadata call and merged in, so the
     * caller gets everything needed to render a useful column list from a single request.
     */
    public static List<ColumnInfo> columns(
            Connection connection,
            String catalog,
            String schema,
            String table) throws SQLException {

        DatabaseMetaData meta = connection.getMetaData();
        Set<String> primaryKeys = primaryKeyColumns(connection, catalog, schema, table);
        String escapedTable = escapeLike(table, meta);
        List<ColumnInfo> result = new ArrayList<>();

        try (ResultSet rows = meta.getColumns(catalog, schema, escapedTable, null)) {
            while (rows.next()) {
                String name = safeString(rows, "COLUMN_NAME");
                if (name == null) {
                    continue;
                }

                // IS_NULLABLE is a string tri-state and is the more reliable signal when present;
                // NULLABLE is an int that drivers are more likely to leave at "unknown".
                String isNullable = safeString(rows, "IS_NULLABLE");
                boolean nullable;
                boolean nullableKnown;
                if (isNullable != null && !isNullable.isBlank()) {
                    nullable = "YES".equalsIgnoreCase(isNullable.trim());
                    nullableKnown = true;
                } else {
                    int nullableCode = safeInt(rows, "NULLABLE", DatabaseMetaData.columnNullableUnknown);
                    nullable = nullableCode != DatabaseMetaData.columnNoNulls;
                    nullableKnown = nullableCode != DatabaseMetaData.columnNullableUnknown;
                }

                result.add(new ColumnInfo(
                        name,
                        safeString(rows, "TYPE_NAME"),
                        safeInt(rows, "DATA_TYPE", java.sql.Types.OTHER),
                        safeInt(rows, "COLUMN_SIZE", 0),
                        safeNullableInt(rows, "DECIMAL_DIGITS"),
                        nullable,
                        nullableKnown,
                        safeString(rows, "COLUMN_DEF"),
                        safeString(rows, "REMARKS"),
                        safeInt(rows, "ORDINAL_POSITION", result.size() + 1),
                        primaryKeys.contains(name),
                        yesNo(safeString(rows, "IS_AUTOINCREMENT")),
                        yesNo(safeString(rows, "IS_GENERATEDCOLUMN")),
                        null));
            }
        }
        return result;
    }

    /** Columns making up the primary key of a table, in key order. */
    public static Set<String> primaryKeyColumns(
            Connection connection,
            String catalog,
            String schema,
            String table) throws SQLException {

        DatabaseMetaData meta = connection.getMetaData();
        Set<String> result = new LinkedHashSet<>();
        try (ResultSet rows = meta.getPrimaryKeys(catalog, schema, table)) {
            while (rows.next()) {
                String name = safeString(rows, "COLUMN_NAME");
                if (name != null && !name.isEmpty()) {
                    result.add(name);
                }
            }
        } catch (SQLException | RuntimeException failure) {
            Log.debug("primary key lookup failed for %s: %s", table, failure.getMessage());
        }
        return result;
    }

    /**
     * Indexes on a table.
     *
     * <p>Entries whose column name is {@code null} are driver-emitted table statistics rather
     * than real index columns and are filtered out, since they only confuse an index listing.
     */
    public static List<IndexInfo> indexes(
            Connection connection,
            String catalog,
            String schema,
            String table) throws SQLException {

        DatabaseMetaData meta = connection.getMetaData();
        List<IndexInfo> result = new ArrayList<>();
        try (ResultSet rows = meta.getIndexInfo(catalog, schema, table, false, true)) {
            while (rows.next()) {
                String columnName = safeString(rows, "COLUMN_NAME");
                if (columnName == null || columnName.isEmpty()) {
                    continue;
                }
                result.add(new IndexInfo(
                        safeString(rows, "INDEX_NAME"),
                        !safeBoolean(rows, "NON_UNIQUE", true),
                        safeInt(rows, "TYPE", DatabaseMetaData.tableIndexOther),
                        safeInt(rows, "ORDINAL_POSITION", 0),
                        columnName,
                        safeString(rows, "ASC_OR_DESC"),
                        safeLong(rows, "CARDINALITY", -1L)));
            }
        } catch (SQLException | RuntimeException failure) {
            Log.debug("index lookup failed for %s: %s", table, failure.getMessage());
        }
        return result;
    }

    /**
     * The {@code TABLE_TYPE} labels this driver uses, such as {@code TABLE}, {@code VIEW} or
     * {@code SYSTEM TABLE}.
     *
     * <p>Exposed so callers can group objects by the labels the database actually emits rather
     * than by a list baked into the client, which would be wrong for at least one database.
     */
    public static List<String> tableTypes(Connection connection) {
        List<String> result = new ArrayList<>();
        try (ResultSet rows = connection.getMetaData().getTableTypes()) {
            while (rows.next()) {
                String type = safeString(rows, "TABLE_TYPE");
                if (type != null && !type.isBlank()) {
                    result.add(type);
                }
            }
        } catch (SQLException | RuntimeException failure) {
            Log.debug("table types are unavailable: %s", failure.getMessage());
        }
        return result;
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /**
     * Escapes LIKE metacharacters so a literal name is matched exactly.
     *
     * <p>Apply this only when converting a <em>literal</em> name into a pattern - looking up the
     * columns of one named table, for instance. Escaping a value that is already a pattern destroys
     * its meaning: {@code "%"} becomes {@code "\%"} and matches only a table literally named
     * percent.
     *
     * <p>The escape character comes from the driver's own {@code getSearchStringEscape} rather than
     * assuming a backslash, because drivers disagree about which character does the job.
     */
    public static String escapeLike(String value, DatabaseMetaData meta) {
        if (value == null) {
            return null;
        }
        String escape = MetadataSupport.value(meta::getSearchStringEscape, "\\");
        if (escape == null || escape.isEmpty()) {
            return value;
        }
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '%' || c == '_' || escape.indexOf(c) >= 0) {
                out.append(escape);
            }
            out.append(c);
        }
        return out.toString();
    }

    private static boolean yesNo(String value) {
        return value != null && "YES".equalsIgnoreCase(value.trim());
    }

    /** Reads a string column, tolerating drivers that do not implement it at all. */
    private static String safeString(ResultSet rows, String label) {
        try {
            return rows.getString(label);
        } catch (SQLException | RuntimeException ignored) {
            return null;
        }
    }

    private static int safeInt(ResultSet rows, String label, int fallback) {
        try {
            int value = rows.getInt(label);
            return rows.wasNull() ? fallback : value;
        } catch (SQLException | RuntimeException ignored) {
            return fallback;
        }
    }

    private static long safeLong(ResultSet rows, String label, long fallback) {
        try {
            long value = rows.getLong(label);
            return rows.wasNull() ? fallback : value;
        } catch (SQLException | RuntimeException ignored) {
            return fallback;
        }
    }

    private static Integer safeNullableInt(ResultSet rows, String label) {
        try {
            int value = rows.getInt(label);
            return rows.wasNull() ? null : value;
        } catch (SQLException | RuntimeException ignored) {
            return null;
        }
    }

    private static boolean safeBoolean(ResultSet rows, String label, boolean fallback) {
        try {
            boolean value = rows.getBoolean(label);
            return rows.wasNull() ? fallback : value;
        } catch (SQLException | RuntimeException ignored) {
            return fallback;
        }
    }
}
