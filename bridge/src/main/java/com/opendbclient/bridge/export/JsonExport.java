package com.opendbclient.bridge.export;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.result.ResultColumn;

/**
 * Writes an array of objects, one per row, streaming.
 *
 * <p>Values keep their JSON types - numbers stay numbers, null stays null - so a consumer can compute
 * on the result rather than re-parsing strings. That is the reason to choose JSON over CSV in the
 * first place, and flattening everything to text would throw it away.
 *
 * <p>Column names become keys. Two columns can legitimately share a name - {@code SELECT a.id, b.id}
 * is ordinary SQL - and a JSON object cannot hold the same key twice, so later duplicates are
 * suffixed. Losing a column silently would be worse than an ugly key.
 */
public final class JsonExport implements ExportTarget {

    private final Path target;
    private final boolean pretty;

    private Writer writer;
    private String[] keys;
    private boolean firstRow = true;

    public JsonExport(Path target, boolean pretty) {
        this.target = target;
        this.pretty = pretty;
    }

    @Override
    public void begin(List<ResultColumn> columns) throws IOException {
        OutputStream out = Files.newOutputStream(target);
        this.writer = new BufferedWriter(new OutputStreamWriter(out, StandardCharsets.UTF_8), 64 * 1024);
        this.keys = uniqueKeys(columns);
        writer.write(pretty ? "[\n" : "[");
    }

    @Override
    public void row(List<Object> values) throws IOException {
        Map<String, Object> object = new LinkedHashMap<>(keys.length * 2);
        for (int i = 0; i < keys.length; i++) {
            object.put(keys[i], i < values.size() ? values.get(i) : null);
        }

        if (!firstRow) {
            writer.write(pretty ? ",\n" : ",");
        }
        firstRow = false;
        writer.write(pretty ? "  " + Json.write(object) : Json.write(object));
    }

    @Override
    public void end() throws IOException {
        if (writer == null) {
            return;
        }
        writer.write(pretty && !firstRow ? "\n]\n" : "]");
        writer.flush();
    }

    @Override
    public void close() throws IOException {
        if (writer != null) {
            writer.close();
            writer = null;
        }
    }

    /**
     * Derives a distinct key for every column, in order.
     *
     * Falls back to the ordinal when a column has no name at all, which happens with computed
     * expressions on drivers that do not synthesise one.
     */
    private static String[] uniqueKeys(List<ResultColumn> columns) {
        Set<String> used = new HashSet<>(columns.size() * 2);
        String[] keys = new String[columns.size()];

        for (int i = 0; i < columns.size(); i++) {
            ResultColumn column = columns.get(i);
            String base = column.label() == null || column.label().isBlank()
                    ? "column_" + (i + 1)
                    : column.label();

            String candidate = base;
            int suffix = 2;
            while (!used.add(candidate)) {
                candidate = base + "_" + suffix++;
            }
            keys[i] = candidate;
        }
        return keys;
    }
}
