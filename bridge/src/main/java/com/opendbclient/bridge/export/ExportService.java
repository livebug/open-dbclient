package com.opendbclient.bridge.export;

import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;

import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.rpc.RpcException;

/** Chooses an {@link ExportTarget} for a requested format. */
public final class ExportService {

    /** Excel's own ceiling, used when the caller does not specify one. */
    private static final int DEFAULT_ROWS_PER_SHEET = 1_048_576;

    private static final int DEFAULT_INSERT_ROWS_PER_STATEMENT = 100;

    private ExportService() {
    }

    /** Formats this build can write, for error messages and for the extension's file dialog. */
    public static java.util.List<String> supportedFormats() {
        return java.util.List.of("csv", "json", "sql", "xlsx");
    }

    /**
     * Creates the writer for a format.
     *
     * @param format     one of {@code csv}, {@code json}, {@code sql}, {@code xlsx}
     * @param target     file to write; parents are the caller's responsibility
     * @param options    format-specific settings, all optional
     * @param tableName  table name for {@code sql} output, taken verbatim so a caller can pre-quote it
     * @throws RpcException with {@code INVALID_PARAMS} for an unknown format or a missing requirement
     */
    public static ExportTarget create(
            String format,
            Path target,
            Map<String, Object> options,
            String tableName) {

        String normalized = format == null ? "" : format.toLowerCase(Locale.ROOT).trim();
        return switch (normalized) {
            case "csv" -> new CsvExport(
                    target,
                    Json.str(options, "delimiter", ","),
                    Json.bool(options, "includeHeader", true),
                    Json.bool(options, "writeBom", true));

            case "json" -> new JsonExport(target, Json.bool(options, "pretty", false));

            case "sql" -> new SqlInsertExport(
                    target,
                    requireTableName(tableName),
                    Json.intValue(options, "rowsPerStatement", DEFAULT_INSERT_ROWS_PER_STATEMENT),
                    Json.str(options, "statementTerminator", ";"));

            case "xlsx" -> new XlsxExport(
                    target,
                    Json.intValue(options, "maxRowsPerSheet", DEFAULT_ROWS_PER_SHEET),
                    Json.bool(options, "includeHeader", true));

            default -> throw RpcException.invalidParams(
                    "unsupported export format '" + format + "'; expected one of "
                            + String.join(", ", supportedFormats()));
        };
    }

    private static String requireTableName(String tableName) {
        if (tableName == null || tableName.isBlank()) {
            // Not defaulted: guessing a table name produces a script that quietly writes to the wrong
            // place, and the caller always knows the name it wants.
            throw RpcException.invalidParams("a tableName is required when exporting as INSERT statements");
        }
        return tableName;
    }
}
