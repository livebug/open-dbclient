package com.opendbclient.bridge.json;

/**
 * Thrown when JSON text cannot be parsed.
 *
 * <p>The message carries a {@code line:column} prefix so malformed input from the
 * extension host can be traced back to a specific position without a debugger.
 */
public class JsonException extends RuntimeException {

    private final int line;
    private final int column;

    public JsonException(String message, int line, int column) {
        super("line " + line + ", column " + column + ": " + message);
        this.line = line;
        this.column = column;
    }

    public JsonException(String message) {
        super(message);
        this.line = -1;
        this.column = -1;
    }

    public int line() {
        return line;
    }

    public int column() {
        return column;
    }
}
