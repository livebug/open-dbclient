package com.opendbclient.bridge.export;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import com.opendbclient.bridge.result.ResultColumn;

/**
 * Writes RFC 4180 CSV, with the separator and the quoting policy configurable.
 *
 * <p>Three details exist because tools disagree about them, and each was chosen for how it behaves on
 * the receiving end rather than for tidiness:
 *
 * - <b>CRLF line endings.</b> The specification calls for them and Excel on Windows expects them;
 *   everything else accepts them too.
 * - <b>Optional UTF-8 BOM.</b> Excel will misread a BOM-less UTF-8 file as the local codepage, which
 *   turns CJK text into mojibake. The BOM fixes that and is configurable because some command-line
 *   tools pass it through as data.
 * - <b>Configurable quoting.</b> Minimal quoting is the default (a field is quoted only when it
 *   contains the separator, a quote, or a line break, which is what makes a file readable in a plain
 *   editor); `always` and `never` exist because a downstream tool may demand one or forbid the other.
 *
 * <h2>Why a separator may be several characters</h2>
 *
 * Nothing in the format requires one character - it is a separator string - and multi-character
 * separators such as {@code ~@~} are the only safe choice when the data itself is full of commas,
 * semicolons, tabs and pipes. The consequence is that "does this field need quoting" is a substring
 * test, not a character test, and that a separator containing a quote or a line break is rejected
 * rather than written: such a file cannot be parsed back by anybody.
 */
public final class CsvExport implements ExportTarget {

    /** Quotes written around every field, in the order a file's data is written. */
    private static final char QUOTE = '"';

    /** How a field is quoted. */
    public enum Quoting {
        /** Only when the field would otherwise be misread. The default. */
        MINIMAL,
        /** Every field, header included. */
        ALWAYS,
        /** Never, even when the field contains the separator. */
        NEVER;

        /** Reads a mode by name, falling back to {@link #MINIMAL} for anything unrecognised. */
        public static Quoting parse(String value) {
            if (value != null) {
                switch (value.trim().toLowerCase(java.util.Locale.ROOT)) {
                    case "always", "all" -> {
                        return ALWAYS;
                    }
                    case "never", "none", "off" -> {
                        return NEVER;
                    }
                    default -> {
                        return MINIMAL;
                    }
                }
            }
            return MINIMAL;
        }
    }

    /** Everything about a CSV export that the caller decides. */
    public record Options(
            String delimiter,
            Quoting quoting,
            boolean includeHeader,
            boolean writeBom,
            boolean useColumnRemarks) {

        public static final Options DEFAULT =
                new Options(",", Quoting.MINIMAL, true, true, true);

        /**
         * Normalises a caller's request.
         *
         * @throws IllegalArgumentException for a separator that cannot be written safely, which is a
         *                                  mistake worth reporting rather than silently repairing: a
         *                                  separator the user asked for and did not get would show up
         *                                  much later, as a file that reads wrong.
         */
        public Options {
            if (delimiter == null || delimiter.isEmpty()) {
                delimiter = DEFAULT.delimiter();
            }
            if (quoting == null) {
                quoting = Quoting.MINIMAL;
            }
            for (int i = 0; i < delimiter.length(); i++) {
                char candidate = delimiter.charAt(i);
                if (candidate == QUOTE || candidate == '\n' || candidate == '\r') {
                    throw new IllegalArgumentException(
                            "a CSV separator cannot contain a quote, a carriage return or a line feed");
                }
            }
        }
    }

    private final Path target;
    private final Options options;

    private Writer writer;

    /** Fields written without the quotes they needed, reported through {@link #unquotedFields()}. */
    private long unquotedFields;

    public CsvExport(Path target, Options options) {
        this.target = target;
        this.options = options == null ? Options.DEFAULT : options;
    }

    @Override
    public void begin(List<ResultColumn> columns) throws IOException {
        OutputStream out = Files.newOutputStream(target);
        if (options.writeBom()) {
            out.write(new byte[] {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF});
        }
        this.writer = new BufferedWriter(new OutputStreamWriter(out, StandardCharsets.UTF_8), 64 * 1024);

        if (options.includeHeader()) {
            StringBuilder line = new StringBuilder();
            for (int i = 0; i < columns.size(); i++) {
                if (i > 0) {
                    line.append(options.delimiter());
                }
                line.append(field(ExportTarget.headerLabel(columns.get(i), options.useColumnRemarks())));
            }
            line.append("\r\n");
            writer.write(line.toString());
        }
    }

    @Override
    public void row(List<Object> values) throws IOException {
        StringBuilder line = new StringBuilder(values.size() * 16);
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) {
                line.append(options.delimiter());
            }
            line.append(field(ExportTarget.renderText(values.get(i))));
        }
        line.append("\r\n");
        writer.write(line.toString());
    }

    @Override
    public void end() throws IOException {
        if (writer != null) {
            writer.flush();
        }
    }

    @Override
    public void close() throws IOException {
        if (writer != null) {
            writer.close();
            writer = null;
        }
    }

    /**
     * Writes a field the way the configured quoting mode asks for.
     *
     * <p>Embedded quotes are doubled, which is how the format escapes them and what every reader
     * reverses on the way back in.
     *
     * <p>With quoting off, a field containing the separator, a quote or a line break is written as it
     * is and counted. Counting rather than refusing is deliberate: refusing would mean re-reading a
     * result nobody is holding any more, and the user asked for no quotes - but they are told, because
     * the alternative is discovering it when the file is loaded back months later.
     */
    private String field(String value) {
        boolean needsQuotes = requiresQuotes(value);

        if (options.quoting() == Quoting.NEVER) {
            if (needsQuotes) {
                unquotedFields++;
            }
            return value;
        }
        if (options.quoting() == Quoting.MINIMAL && !needsQuotes) {
            return value;
        }
        return QUOTE + value.replace(String.valueOf(QUOTE), String.valueOf(QUOTE) + QUOTE) + QUOTE;
    }

    /**
     * Whether a reader would misparse the raw field.
     *
     * A substring test, not a character test: the separator may be several characters long, and a
     * field containing only part of it - `~` when the separator is `~@~` - needs no quoting at all.
     */
    private boolean requiresQuotes(String value) {
        return value.contains(options.delimiter())
                || value.indexOf(QUOTE) >= 0
                || value.indexOf('\n') >= 0
                || value.indexOf('\r') >= 0;
    }

    @Override
    public long unquotedFields() {
        return unquotedFields;
    }
}
