package com.opendbclient.bridge.metadata;

import java.util.Map;

import com.opendbclient.bridge.json.Json;

/**
 * One column of one index.
 *
 * <p>An index with several columns appears as several entries sharing a name, ordered by
 * {@code ordinal}, because that is how {@code DatabaseMetaData.getIndexInfo} reports it.
 *
 * @param name        index name, or {@code null} for the pseudo-index backing a table's statistics
 * @param unique      index enforces uniqueness
 * @param type        {@link java.sql.DatabaseMetaData} index type constant
 * @param ordinal     one-based position of this column within the index
 * @param columnName  indexed column, or {@code null} for a table statistics entry
 * @param ascending   {@code "A"} for ascending, {@code "D"} for descending
 * @param cardinality number of unique values, when the driver knows it
 */
public record IndexInfo(
        String name,
        boolean unique,
        int type,
        int ordinal,
        String columnName,
        String ascending,
        long cardinality) {

    public Map<String, Object> toPayload() {
        Map<String, Object> payload = Json.obj(
                "name", name,
                "unique", unique,
                "type", type,
                "typeName", typeName(),
                "ordinal", ordinal,
                "uniqueKnown", cardinality >= 0);
        if (columnName != null) {
            payload.put("columnName", columnName);
        }
        if (ascending != null && !ascending.isBlank()) {
            payload.put("ascending", "A".equalsIgnoreCase(ascending));
        }
        if (cardinality >= 0) {
            payload.put("cardinality", cardinality);
        }
        return payload;
    }

    private String typeName() {
        return switch (type) {
            case java.sql.DatabaseMetaData.tableIndexStatistic -> "tableStatistics";
            case java.sql.DatabaseMetaData.tableIndexClustered -> "clustered";
            case java.sql.DatabaseMetaData.tableIndexHashed -> "hashed";
            case java.sql.DatabaseMetaData.tableIndexOther -> "other";
            default -> "unknown";
        };
    }
}
