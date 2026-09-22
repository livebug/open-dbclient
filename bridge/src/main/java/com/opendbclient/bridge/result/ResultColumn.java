package com.opendbclient.bridge.result;

import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.metadata.ColumnInfo;

/**
 * A column in a query result.
 *
 * <p>Distinct from {@link com.opendbclient.bridge.metadata.ColumnInfo}, which describes a column of
 * a table and is read from {@code DatabaseMetaData}. This describes a column of a result set and
 * comes from {@link ResultSetMetaData}, so it must cope with computed expressions that belong to no
 * table, unnamed columns, and drivers that omit optional metadata entirely.
 *
 * @param name        column name, falling back to the label and then to an ordinal
 * @param label       label the driver assigned, which is the SQL alias when there is one
 * @param tableName   originating table, when the driver can attribute the column
 * @param schemaName  originating schema, when the driver reports one
 * @param typeName    type name in the database's own vocabulary
 * @param jdbcType    {@link java.sql.Types} constant
 * @param precision   declared precision, 0 when unknown
 * @param scale       declared scale, 0 when unknown
 * @param nullable    the column may contain null
 * @param displayType type rendered for display, e.g. {@code varchar(255)}
 */
public record ResultColumn(
        String name,
        String label,
        String tableName,
        String schemaName,
        String typeName,
        int jdbcType,
        int precision,
        int scale,
        boolean nullable,
        String displayType) {

    /**
     * Reads column metadata for a result set.
     *
     * <p>Every field is read defensively. Expensive as that looks, it is the difference between a
     * query returning and a query failing: drivers routinely throw from optional metadata methods,
     * and a column that merely lacks a type name is far better than no results at all.
     */
    public static List<ResultColumn> read(ResultSetMetaData meta) throws SQLException {
        int count = meta.getColumnCount();
        List<ResultColumn> columns = new ArrayList<>(count);

        for (int position = 1; position <= count; position++) {
            // Copied so the lambdas below can capture it: a loop variable that is reassigned is not
            // effectively final, and these reads are deferred.
            final int index = position;

            String label = value(() -> meta.getColumnLabel(index), null);
            String name = value(() -> meta.getColumnName(index), null);
            String typeName = value(() -> meta.getColumnTypeName(index), null);
            int jdbcType = integer(() -> meta.getColumnType(index), java.sql.Types.OTHER);
            int precision = integer(() -> meta.getPrecision(index), 0);
            int scale = integer(() -> meta.getScale(index), 0);
            boolean nullable = nullable(meta, index);

            String effectiveName = firstNonBlank(name, label, "column_" + index);
            columns.add(new ResultColumn(
                    effectiveName,
                    firstNonBlank(label, name, effectiveName),
                    value(() -> meta.getTableName(index), null),
                    value(() -> meta.getSchemaName(index), null),
                    firstNonBlank(typeName, "UNKNOWN"),
                    jdbcType,
                    precision,
                    scale,
                    nullable,
                    renderType(typeName, jdbcType, precision, scale)));
        }
        return columns;
    }

    /** Renders the type for display, applying the same length rules as table metadata. */
    private static String renderType(String typeName, int jdbcType, int precision, int scale) {
        String base = firstNonBlank(typeName, "UNKNOWN");
        // Only the string and fixed-point types carry a length worth showing; see ColumnInfo for the
        // measurements behind this restriction.
        switch (jdbcType) {
            case java.sql.Types.CHAR, java.sql.Types.VARCHAR, java.sql.Types.NCHAR,
                 java.sql.Types.NVARCHAR, java.sql.Types.BINARY, java.sql.Types.VARBINARY,
                 java.sql.Types.DECIMAL, java.sql.Types.NUMERIC:
                break;
            default:
                return base;
        }
        if (precision <= 0 || precision >= 100_000_000) {
            return base;
        }
        if (scale > 0) {
            return base + "(" + precision + "," + scale + ")";
        }
        return base + "(" + precision + ")";
    }

    private static boolean nullable(ResultSetMetaData meta, int index) {
        // The JDBC tri-state: 0 means definitely not nullable, 1 means nullable, and 2 means the
        // driver does not know. Unknown is reported as nullable so the UI never claims a column
        // cannot contain null on the strength of a driver that said nothing.
        int code = integer(() -> meta.isNullable(index), ResultSetMetaData.columnNullableUnknown);
        return code != ResultSetMetaData.columnNoNulls;
    }

    public Map<String, Object> toPayload() {
        Map<String, Object> payload = Json.obj(
                "name", name,
                "label", label,
                "typeName", typeName,
                "displayType", displayType,
                "jdbcType", jdbcType,
                "jdbcTypeName", ColumnInfo.JdbcTypes.nameOf(jdbcType),
                "nullable", nullable);
        if (tableName != null && !tableName.isBlank()) {
            payload.put("tableName", tableName);
        }
        if (schemaName != null && !schemaName.isBlank()) {
            payload.put("schemaName", schemaName);
        }
        return payload;
    }

    private static String firstNonBlank(String... candidates) {
        for (String candidate : candidates) {
            if (candidate != null && !candidate.isBlank()) {
                return candidate;
            }
        }
        return null;
    }

    private static String value(MetadataCall<String> call, String fallback) {
        try {
            String result = call.get();
            return result == null || result.isBlank() ? fallback : result;
        } catch (SQLException | RuntimeException | LinkageError failure) {
            Log.debug("result column metadata probe failed: %s", failure.getMessage());
            return fallback;
        }
    }

    private static int integer(MetadataCall<Integer> call, int fallback) {
        try {
            Integer result = call.get();
            return result == null ? fallback : result;
        } catch (SQLException | RuntimeException | LinkageError failure) {
            return fallback;
        }
    }

    /** A metadata call that may fail, used to keep the defensive reads above readable. */
    @FunctionalInterface
    private interface MetadataCall<T> {
        T get() throws SQLException;
    }
}
