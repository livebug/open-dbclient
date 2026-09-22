package com.opendbclient.bridge.result;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

import com.opendbclient.bridge.log.Log;

/**
 * Reads rows from a {@link ResultSet} into JSON-friendly values.
 *
 * <p>Shared by query execution and export, which stream the same rows to different destinations and
 * must not diverge in how they interpret them. An exported value that differs from the one shown in
 * the grid would be a subtle and infuriating bug.
 */
public final class RowReader {

    private RowReader() {
    }

    /** Reads the current row, converting every column. */
    public static List<Object> read(ResultSet rows, int columnCount) {
        List<Object> values = new ArrayList<>(columnCount);
        for (int index = 1; index <= columnCount; index++) {
            values.add(readCell(rows, index));
        }
        return values;
    }

    /**
     * Reads one cell, degrading to a visible marker rather than failing the row.
     *
     * Drivers raise errors for individual columns far more often than for a whole result set -
     * unreadable LOBs, unsupported vendor types, a permission that covers one column. Losing the
     * other forty columns of a row to surface one is a bad trade, and the marker makes the
     * substitution obvious instead of quietly presenting a wrong value.
     */
    private static Object readCell(ResultSet rows, int index) {
        try {
            return ValueConverter.toJsonValue(rows.getObject(index));
        } catch (SQLException | RuntimeException failure) {
            Log.debug("Could not read column %d: %s", index, failure.getMessage());
            return "[error reading value: " + failure.getMessage() + "]";
        }
    }
}
