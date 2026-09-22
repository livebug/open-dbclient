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
 * Writes RFC 4180 CSV.
 *
 * <p>Three details exist because tools disagree about them, and each was chosen for how it behaves on
 * the receiving end rather than for tidiness:
 *
 * - <b>CRLF line endings.</b> The specification calls for them and Excel on Windows expects them;
 *   everything else accepts them too.
 * - <b>Optional UTF-8 BOM.</b> Excel will misread a BOM-less UTF-8 file as the local codepage, which
 *   turns CJK text into mojibake. The BOM fixes that and is configurable because some command-line
 *   tools pass it through as data.
 * - <b>Minimal quoting.</b> A field is quoted only when it contains a delimiter, a quote, or a line
 *   break. Quoting everything would be simpler but makes files harder to read in a plain editor.
 */
public final class CsvExport implements ExportTarget {

    private final Path target;
    private final String delimiter;
    private final boolean includeHeader;
    private final boolean writeBom;

    private Writer writer;

    public CsvExport(Path target, String delimiter, boolean includeHeader, boolean writeBom) {
        this.target = target;
        this.delimiter = delimiter == null || delimiter.isEmpty() ? "," : delimiter;
        this.includeHeader = includeHeader;
        this.writeBom = writeBom;
    }

    @Override
    public void begin(List<ResultColumn> columns) throws IOException {
        OutputStream out = Files.newOutputStream(target);
        if (writeBom) {
            out.write(new byte[] {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF});
        }
        this.writer = new BufferedWriter(new OutputStreamWriter(out, StandardCharsets.UTF_8), 64 * 1024);

        if (includeHeader) {
            StringBuilder line = new StringBuilder();
            for (int i = 0; i < columns.size(); i++) {
                if (i > 0) {
                    line.append(delimiter);
                }
                line.append(quote(columns.get(i).label()));
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
                line.append(delimiter);
            }
            line.append(quote(ExportTarget.renderText(values.get(i))));
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
     * Quotes a field when it needs it.
     *
     * Embedded quotes are doubled, which is how the format escapes them and what every reader
     * reverses on the way back in.
     */
    private String quote(String value) {
        boolean needsQuotes = value.indexOf(delimiter.charAt(0)) >= 0
                || value.indexOf('"') >= 0
                || value.indexOf('\n') >= 0
                || value.indexOf('\r') >= 0;

        if (!needsQuotes) {
            return value;
        }
        return '"' + value.replace("\"", "\"\"") + '"';
    }
}
