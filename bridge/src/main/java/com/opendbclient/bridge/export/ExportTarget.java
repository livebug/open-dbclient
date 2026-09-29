package com.opendbclient.bridge.export;

import java.io.IOException;
import java.util.List;

import com.opendbclient.bridge.result.ResultColumn;

/**
 * A destination rows are streamed into.
 *
 * <p>Every implementation writes incrementally. Export is the one operation where the volume is
 * unbounded and deliberately so - a user exporting a table means <em>all</em> of it - which makes
 * buffering the result a non-option. A million-row export must cost a bounded amount of memory.
 *
 * <p>Values arrive already converted by {@link com.opendbclient.bridge.result.ValueConverter}, so
 * they are {@code null}, {@link String}, {@link Boolean}, {@link Number}, or a {@link List} for a
 * SQL array. Implementations decide how to render each of those for their format.
 */
public interface ExportTarget extends AutoCloseable {

    /** Called once before any row. Implementations emit their header here. */
    void begin(List<ResultColumn> columns) throws IOException;

    /** Writes one row. Called once per row, in order. */
    void row(List<Object> values) throws IOException;

    /** Called once after the last row. Implementations close their document here. */
    void end() throws IOException;

    /**
     * How many fields in the written file a reader may misparse; zero when there are none.
     *
     * <p>CSV is the only format with a way to get this wrong: with quoting turned off, a field containing
     * the separator, a quote or a line break is written as it is, and the file may not read back. The write
     * is still the right thing to do - the user asked for it - but they are told, because the alternative
     * is finding out when the file is loaded again months later.
     *
     * <p>A count rather than a sentence: the wording belongs to whatever is showing it to the user, and
     * that layer is the one that knows which language to write it in.
     */
    default long unquotedFields() {
        return 0L;
    }

    @Override
    void close() throws IOException;

    /** Renders a value as plain text, the form CSV and Excel need. */
    static String renderText(Object value) {
        if (value == null) {
            return "";
        }
        if (value instanceof String text) {
            return text;
        }
        if (value instanceof Boolean flag) {
            return flag ? "true" : "false";
        }
        if (value instanceof List<?> array) {
            // A SQL array has no textual form of its own; JSON is unambiguous and readable.
            StringBuilder text = new StringBuilder("[");
            for (int i = 0; i < array.size(); i++) {
                if (i > 0) {
                    text.append(", ");
                }
                text.append(renderText(array.get(i)));
            }
            return text.append(']').toString();
        }
        return String.valueOf(value);
    }

    /**
     * The text to put in a header cell for one column.
     *
     * <p>Only the report-like formats use this. JSON and INSERT statements keep the physical name:
     * they exist to be read by another program, and a comment is documentation rather than an
     * identifier - a Chinese comment used as a JSON key or as an INSERT column list would produce a
     * file that no longer loads.
     *
     * @param useRemarks when false the physical label is always used, whatever the driver reported
     */
    static String headerLabel(ResultColumn column, boolean useRemarks) {
        if (useRemarks && column.remarks() != null && !column.remarks().isBlank()) {
            return column.remarks();
        }
        return column.label() == null || column.label().isBlank() ? column.name() : column.label();
    }
}
