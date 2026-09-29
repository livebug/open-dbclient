package com.opendbclient.bridge.result;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.metadata.MetadataProvider;

/**
 * Looks up the comment of result columns that belong to a table.
 *
 * <h2>Why this is worth a metadata round trip</h2>
 *
 * On a great many schemas the physical column name is an abbreviation - {@code CUST_NO},
 * {@code AMT_01} - and the comment is the name people actually use, often in Chinese. A grid that
 * shows only the physical names is technically correct and practically unreadable.
 *
 * <h2>Why it is defensive to the point of paranoia</h2>
 *
 * A comment is decoration. Every failure below - a driver that throws from {@code getColumns}, a
 * comment column the driver does not fill, a query whose columns belong to no table at all - must end
 * in "the result is displayed without comments" rather than "the query failed". The cheap drivers this
 * project targets are exactly the ones that throw from the optional corners of {@code DatabaseMetaData}.
 *
 * <p>One lookup is made per distinct table in the result, never per column: {@code getColumns} returns
 * every column of a table at once, so a twenty-column result over two tables costs two calls.
 */
final class ColumnRemarks {

    private ColumnRemarks() {
    }

    /** Returns the columns, with a comment attached wherever one could be read. */
    static List<ResultColumn> attach(List<ResultColumn> columns, Connection connection) {
        if (connection == null || !hasAttributedColumn(columns)) {
            return columns;
        }

        DatabaseMetaData meta;
        try {
            meta = connection.getMetaData();
        } catch (SQLException | RuntimeException failure) {
            Log.debug("Could not read database metadata for column comments: %s", failure.getMessage());
            return columns;
        }

        // Keyed by table so a wide result over a few tables costs a few calls rather than one per
        // column. The map holds lower-cased column names, because drivers disagree about the case in
        // which they report REMARKS against COLUMN_NAME.
        Map<String, Map<String, String>> byTable = new HashMap<>();
        List<ResultColumn> enriched = new ArrayList<>(columns.size());

        for (ResultColumn column : columns) {
            String table = column.tableName();
            if (table == null || table.isBlank()) {
                enriched.add(column);
                continue;
            }
            String key = tableKey(column);
            Map<String, String> comments = byTable.get(key);
            if (comments == null) {
                comments = readTable(meta, column);
                byTable.put(key, comments);
            }
            String comment = comments.get(column.name().toLowerCase(Locale.ROOT));
            enriched.add(comment == null || comment.isBlank() ? column : column.withRemarks(comment));
        }

        return enriched;
    }

    private static boolean hasAttributedColumn(List<ResultColumn> columns) {
        for (ResultColumn column : columns) {
            if (column.tableName() != null && !column.tableName().isBlank()) {
                return true;
            }
        }
        return false;
    }

    private static String tableKey(ResultColumn column) {
        return (column.catalogName() == null ? "" : column.catalogName())
                + '|' + (column.schemaName() == null ? "" : column.schemaName())
                + '|' + column.tableName().toLowerCase(Locale.ROOT);
    }

    /**
     * Reads every column of one table, mapped from column name to comment.
     *
     * <p>The table name is escaped before it is used as a pattern: {@code getColumns} treats it as a
     * LIKE pattern, where {@code _} matches any character, so {@code user_account} would also match
     * {@code userXaccount} and the comments of the wrong table would be displayed.
     */
    private static Map<String, String> readTable(DatabaseMetaData meta, ResultColumn column) {
        Map<String, String> comments = readTable(meta, column, column.catalogName(), column.schemaName());
        if (!comments.isEmpty()) {
            return comments;
        }

        // Some drivers only answer when the catalog and schema are left out, and others only answer
        // when they are supplied. Trying the other spelling once is cheaper than explaining to a user
        // why their comments appear on one database and not another.
        if (isBlank(column.catalogName()) && isBlank(column.schemaName())) {
            return comments;
        }
        return readTable(meta, column, null, null);
    }

    private static Map<String, String> readTable(
            DatabaseMetaData meta,
            ResultColumn column,
            String catalog,
            String schema) {

        Map<String, String> comments = new HashMap<>();
        try {
            String pattern = MetadataProvider.escapeLike(column.tableName(), meta);
            // A null column pattern means "every column", which is what makes this one call per table.
            try (ResultSet rows = meta.getColumns(blankToNull(catalog), blankToNull(schema), pattern, null)) {
                while (rows != null && rows.next()) {
                    String name = safeString(rows, "COLUMN_NAME");
                    String remarks = safeString(rows, "REMARKS");
                    if (name != null && remarks != null && !remarks.isBlank()) {
                        comments.put(name.toLowerCase(Locale.ROOT), remarks);
                    }
                }
            }
        } catch (SQLException | RuntimeException failure) {
            // Including AbstractMethodError, which poor drivers raise from getColumns itself.
            Log.debug(
                    "Could not read column comments for '%s': %s",
                    column.tableName(),
                    failure.getMessage());
        }
        return comments;
    }

    private static String safeString(ResultSet rows, String label) {
        try {
            return rows.getString(label);
        } catch (SQLException | RuntimeException failure) {
            return null;
        }
    }

    private static String blankToNull(String value) {
        return isBlank(value) ? null : value;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
