package com.opendbclient.bridge.result;

/**
 * Collapses a statement into something that fits on one line.
 *
 * <p>Lives here rather than in each caller because the two callers want different lengths of the same
 * thing: a table cell beside a duration, and a log line that has to be long enough to tell one statement
 * from another. Writing the collapsing twice would eventually produce two different ideas of "one line" -
 * and a newline that survives into a log line breaks the shape of everything around it.
 */
public final class SqlSummary {

    /** Length used for the metrics field, which is rendered in a table cell. */
    public static final int METRICS_LIMIT = 160;

    /** Length used for a log line, which exists to identify the statement being run. */
    public static final int LOG_LIMIT = 1_000;

    private SqlSummary() {
    }

    /**
     * Returns the statement as a single line, cut to {@code limit} characters.
     *
     * <p>A cut statement says so, and says how much there was: without that, a truncated statement reads
     * as a complete one that happens to end mid-word.
     */
    public static String of(String sql, int limit) {
        if (sql == null) {
            return "";
        }
        String collapsed = sql.replaceAll("\\s+", " ").trim();
        if (collapsed.length() <= limit) {
            return collapsed;
        }
        return collapsed.substring(0, limit) + "... (" + collapsed.length() + " chars total)";
    }
}
