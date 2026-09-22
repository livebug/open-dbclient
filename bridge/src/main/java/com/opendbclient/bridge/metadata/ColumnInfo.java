package com.opendbclient.bridge.metadata;

import java.sql.Types;
import java.util.Map;

import com.opendbclient.bridge.json.Json;

/**
 * A column, as reported by {@code DatabaseMetaData.getColumns}.
 *
 * <p>Both the database's own type name and the JDBC type constant are carried. The database name
 * is what a user recognises ({@code NUMBER}, {@code varchar2}, {@code text}); the JDBC constant is
 * what the extension uses to decide how to align or format a value. Losing either one would force
 * the extension to guess.
 *
 * @param name             column name
 * @param typeName         type name in the database's own vocabulary
 * @param jdbcType         {@link java.sql.Types} constant
 * @param size             column size, 0 when the driver does not report one
 * @param decimalDigits    digits after the decimal point, {@code null} when not applicable
 * @param nullable         whether the column accepts null
 * @param nullableKnown    whether the driver actually knew; some drivers cannot say
 * @param defaultValue     default expression, or {@code null}
 * @param remarks          comment, or {@code null}
 * @param ordinal          one-based position in the table
 * @param primaryKey       part of the primary key
 * @param autoIncrement    driver reports the column as auto-increment
 * @param generated        driver reports the column as generated
 * @param columnDefinition the driver's own {@code COLUMN_DEF}-style definition, when supplied
 */
public record ColumnInfo(
        String name,
        String typeName,
        int jdbcType,
        int size,
        Integer decimalDigits,
        boolean nullable,
        boolean nullableKnown,
        String defaultValue,
        String remarks,
        int ordinal,
        boolean primaryKey,
        boolean autoIncrement,
        boolean generated,
        String columnDefinition) {

    public Map<String, Object> toPayload() {
        Map<String, Object> payload = Json.obj(
                "name", name,
                "typeName", typeName == null ? "UNKNOWN" : typeName,
                // Rendered here rather than by the client: deciding whether a length belongs in a type
                // depends on driver quirks that are already encoded in this class, and a second
                // implementation would drift.
                "displayType", displayType(),
                "jdbcType", jdbcType,
                "jdbcTypeName", JdbcTypes.nameOf(jdbcType),
                "size", size,
                "nullable", nullable,
                "nullableKnown", nullableKnown,
                "ordinal", ordinal,
                "primaryKey", primaryKey,
                "autoIncrement", autoIncrement,
                "generated", generated);
        if (decimalDigits != null) {
            payload.put("decimalDigits", decimalDigits);
        }
        if (defaultValue != null) {
            payload.put("defaultValue", defaultValue);
        }
        if (remarks != null && !remarks.isBlank()) {
            payload.put("remarks", remarks);
        }
        if (columnDefinition != null && !columnDefinition.isBlank()) {
            payload.put("columnDefinition", columnDefinition);
        }
        return payload;
    }

    /**
     * Renders the type portion of a column for display, e.g. {@code varchar(255)} or
     * {@code NUMBER(10,2)}.
     *
     * <p>Sizes are shown only where a length is actually part of the type, and only when the driver
     * reported a plausible one. Both guards matter in practice: drivers return sizes for types that
     * have no length ({@code INTEGER(2000000000)}), and some use an enormous number as a sentinel
     * meaning "unbounded", which would otherwise be rendered as though the user had asked for a
     * two-billion-character column.
     */
    public String displayType() {
        String base = typeName == null || typeName.isBlank() ? "UNKNOWN" : typeName;
        if (!carriesPrecision(jdbcType) || size <= 0 || size >= SENTINEL_SIZE) {
            return base;
        }
        if (decimalDigits != null && decimalDigits > 0) {
            return base + "(" + size + "," + decimalDigits + ")";
        }
        return base + "(" + size + ")";
    }

    /**
     * Sizes at or above this are driver sentinels for "unbounded" rather than real precisions.
     * Set far above anything a schema would declare, so it cannot swallow a genuine large length.
     */
    private static final int SENTINEL_SIZE = 100_000_000;

    /**
     * Whether a length is part of this JDBC type's definition at all.
     *
     * <p>Floating point types are deliberately excluded even though some databases allow a width on
     * them. Measured behaviour made the trade clear: SQLite reports a declared {@code NUMERIC(10,2)}
     * as {@code Types.FLOAT} with a size of 12, which is neither the declared precision nor the
     * declared type, and PostgreSQL reports {@code double precision} with a size of 15 to 17. Both
     * would render as a precision the user never wrote. Leaving the precision off is incomplete;
     * printing the wrong one is misleading, and only one of those is recoverable by the reader.
     *
     * <p>Character and binary lengths are included because drivers report them faithfully, and
     * {@code DECIMAL}/{@code NUMERIC} because the databases that distinguish fixed-point from
     * floating point - PostgreSQL, Oracle, MySQL - report both precision and scale correctly.
     */
    private static boolean carriesPrecision(int jdbcType) {
        return switch (jdbcType) {
            case Types.CHAR, Types.VARCHAR, Types.NCHAR, Types.NVARCHAR,
                 Types.LONGVARCHAR, Types.LONGNVARCHAR,
                 Types.BINARY, Types.VARBINARY, Types.LONGVARBINARY,
                 Types.DECIMAL, Types.NUMERIC -> true;
            default -> false;
        };
    }

    /** Names for the JDBC type constants, used to make payloads readable without a lookup table. */
    public static final class JdbcTypes {

        private JdbcTypes() {
        }

        public static String nameOf(int jdbcType) {
            return switch (jdbcType) {
                case Types.ARRAY -> "ARRAY";
                case Types.BIGINT -> "BIGINT";
                case Types.BINARY -> "BINARY";
                case Types.BIT -> "BIT";
                case Types.BLOB -> "BLOB";
                case Types.BOOLEAN -> "BOOLEAN";
                case Types.CHAR -> "CHAR";
                case Types.CLOB -> "CLOB";
                case Types.DATE -> "DATE";
                case Types.DECIMAL -> "DECIMAL";
                case Types.DOUBLE -> "DOUBLE";
                case Types.FLOAT -> "FLOAT";
                case Types.INTEGER -> "INTEGER";
                case Types.LONGNVARCHAR -> "LONGNVARCHAR";
                case Types.LONGVARBINARY -> "LONGVARBINARY";
                case Types.LONGVARCHAR -> "LONGVARCHAR";
                case Types.NCHAR -> "NCHAR";
                case Types.NCLOB -> "NCLOB";
                case Types.NUMERIC -> "NUMERIC";
                case Types.NVARCHAR -> "NVARCHAR";
                case Types.OTHER -> "OTHER";
                case Types.REAL -> "REAL";
                case Types.REF -> "REF";
                case Types.SMALLINT -> "SMALLINT";
                case Types.SQLXML -> "SQLXML";
                case Types.STRUCT -> "STRUCT";
                case Types.TIME -> "TIME";
                case Types.TIMESTAMP -> "TIMESTAMP";
                case Types.TIMESTAMP_WITH_TIMEZONE -> "TIMESTAMP_WITH_TIMEZONE";
                case Types.TIME_WITH_TIMEZONE -> "TIME_WITH_TIMEZONE";
                case Types.TINYINT -> "TINYINT";
                case Types.VARBINARY -> "VARBINARY";
                case Types.VARCHAR -> "VARCHAR";
                case Types.ROWID -> "ROWID";
                case Types.NULL -> "NULL";
                default -> "TYPE_" + jdbcType;
            };
        }
    }
}
