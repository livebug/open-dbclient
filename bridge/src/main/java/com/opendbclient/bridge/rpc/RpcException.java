package com.opendbclient.bridge.rpc;

import java.io.IOException;
import java.sql.SQLException;
import java.util.Map;

import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.json.JsonException;

/**
 * A failure that can be reported to the extension host in a structured way.
 *
 * <p>Plain exceptions are converted with {@link #fromThrowable(Throwable)}, which unwraps
 * {@link SQLException} chains so the extension can distinguish "bad credentials" from
 * "table does not exist" without parsing prose.
 */
public class RpcException extends RuntimeException {

    private final String code;
    private final String sqlState;
    private final int vendorErrorCode;

    public RpcException(String code, String message) {
        this(code, message, null, 0, null);
    }

    public RpcException(String code, String message, String sqlState, int vendorErrorCode, Throwable cause) {
        super(message, cause);
        this.code = code;
        this.sqlState = sqlState;
        this.vendorErrorCode = vendorErrorCode;
    }

    public String code() {
        return code;
    }

    public String sqlState() {
        return sqlState;
    }

    public int vendorErrorCode() {
        return vendorErrorCode;
    }

    /** Renders this failure as the {@code error} object of a response frame. */
    public Map<String, Object> toPayload() {
        Map<String, Object> payload = Json.obj("code", code, "message", getMessage());
        if (sqlState != null && !sqlState.isEmpty()) {
            payload.put("sqlState", sqlState);
        }
        if (vendorErrorCode != 0) {
            payload.put("errorCode", vendorErrorCode);
        }
        Throwable cause = getCause();
        if (cause != null && cause != this) {
            payload.put("cause", String.valueOf(cause));
        }
        return payload;
    }

    // ------------------------------------------------------------------
    // factories
    // ------------------------------------------------------------------

    public static RpcException invalidParams(String message) {
        return new RpcException(Protocol.ERROR_INVALID_PARAMS, message);
    }

    public static RpcException unknownMethod(String method) {
        return new RpcException(Protocol.ERROR_UNKNOWN_METHOD, "unknown method '" + method + "'");
    }

    public static RpcException notFound(String what) {
        return new RpcException(Protocol.ERROR_NOT_FOUND, what + " not found");
    }

    public static RpcException unsupported(String message) {
        return new RpcException(Protocol.ERROR_UNSUPPORTED, message);
    }

    /**
     * Maps an arbitrary throwable onto a structured failure, preserving SQL diagnostics
     * and unwrapping reflective failures that driver loading tends to produce.
     */
    public static RpcException fromThrowable(Throwable failure) {
        if (failure instanceof RpcException rpc) {
            return rpc;
        }
        // A malformed request is the caller's mistake, not a bridge defect. Reporting it as an
        // internal error would send users hunting for a bug that does not exist, and would stop
        // the extension from distinguishing bad input from a genuine failure.
        if (failure instanceof JsonException malformed) {
            return new RpcException(
                    Protocol.ERROR_INVALID_PARAMS, malformed.getMessage(), null, 0, malformed);
        }
        SQLException sql = findSqlException(failure);
        if (sql != null) {
            return new RpcException(
                    Protocol.ERROR_SQL,
                    describe(sql),
                    sql.getSQLState(),
                    sql.getErrorCode(),
                    failure);
        }
        if (failure instanceof IOException io) {
            return new RpcException(Protocol.ERROR_IO, String.valueOf(io.getMessage()), null, 0, io);
        }
        String message = failure.getMessage();
        return new RpcException(
                Protocol.ERROR_INTERNAL,
                message == null || message.isEmpty() ? failure.getClass().getName() : message,
                null,
                0,
                failure);
    }

    /**
     * Walks the cause chain looking for a {@link SQLException}.
     *
     * <p>Drivers frequently wrap the useful {@code SQLException} several levels deep inside
     * reflective or pooling wrappers, so surfacing the outermost exception alone would lose
     * the SQL state the user actually needs.
     */
    private static SQLException findSqlException(Throwable failure) {
        Throwable current = failure;
        for (int depth = 0; current != null && depth < 16; depth++) {
            if (current instanceof SQLException sql) {
                return sql;
            }
            Throwable next = current.getCause();
            if (next == null || next == current) {
                break;
            }
            current = next;
        }
        return null;
    }

    /** Builds a readable message from a SQLException, including any chained diagnostics. */
    private static String describe(SQLException sql) {
        StringBuilder text = new StringBuilder();
        text.append(sql.getMessage() == null ? sql.getClass().getSimpleName() : sql.getMessage());
        if (sql.getSQLState() != null) {
            text.append(" (SQLState=").append(sql.getSQLState()).append(')');
        }
        if (sql.getErrorCode() != 0) {
            text.append(" (errorCode=").append(sql.getErrorCode()).append(')');
        }
        SQLException next = sql.getNextException();
        int guard = 0;
        while (next != null && guard++ < 8) {
            text.append(" | ").append(next.getMessage());
            next = next.getNextException();
        }
        return text.toString();
    }
}
