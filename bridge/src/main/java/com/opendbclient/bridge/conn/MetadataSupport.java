package com.opendbclient.bridge.conn;

import java.sql.SQLException;

import com.opendbclient.bridge.log.Log;

/**
 * Defensive wrappers around {@link java.sql.DatabaseMetaData} calls.
 *
 * <p>Different JDBC drivers implement the metadata interface to wildly different standards. It
 * is routine for a driver to throw {@link SQLFeatureNotSupportedException} from methods the
 * specification marks as required, and older drivers compiled against a previous JDBC version
 * can raise {@link AbstractMethodError} because the interface gained a method since. A driver
 * is also free to throw an unchecked exception from a metadata call.
 *
 * <p>None of that should sink a connection. Probing capabilities is best-effort: when a call
 * fails, the caller wants a sensible default rather than an aborted connect. Every value read
 * during capability detection therefore goes through this class.
 */
public final class MetadataSupport {

    /** A metadata call that may fail. */
    @FunctionalInterface
    public interface SqlCall<T> {
        T get() throws SQLException;
    }

    /** A boolean metadata call that may fail. */
    @FunctionalInterface
    public interface SqlBoolean {
        boolean get() throws SQLException;
    }

    /** An integer metadata call that may fail. */
    @FunctionalInterface
    public interface SqlInt {
        int get() throws SQLException;
    }

    private MetadataSupport() {
    }

    /** Runs {@code call}, returning {@code fallback} when it fails or yields {@code null}. */
    public static <T> T value(SqlCall<T> call, T fallback) {
        try {
            T result = call.get();
            return result == null ? fallback : result;
        } catch (Exception | LinkageError failure) {
            // LinkageError covers AbstractMethodError / NoSuchMethodError from drivers built
            // against an older JDBC interface than the one on our classpath.
            logFailure(failure);
            return fallback;
        }
    }

    public static boolean flag(SqlBoolean call, boolean fallback) {
        try {
            return call.get();
        } catch (Exception | LinkageError failure) {
            logFailure(failure);
            return fallback;
        }
    }

    public static int integer(SqlInt call, int fallback) {
        try {
            return call.get();
        } catch (Exception | LinkageError failure) {
            logFailure(failure);
            return fallback;
        }
    }

    /**
     * Reads the identifier quote string, normalising "no quoting" to {@code null}.
     *
     * <p>The JDBC specification says a driver that does not support quoted identifiers returns
     * a single space rather than {@code null} or an empty string. Callers that concatenate this
     * into SQL must not emit a space in place of an opening quote, so the sentinel is converted
     * to {@code null} here once instead of at every call site.
     */
    public static String identifierQuote(java.sql.DatabaseMetaData meta) {
        String quote = value(meta::getIdentifierQuoteString, null);
        if (quote == null || quote.isBlank()) {
            return null;
        }
        return quote;
    }

    private static void logFailure(Throwable failure) {
        Log.debug("metadata probe failed, using default: %s: %s",
                failure.getClass().getSimpleName(), failure.getMessage());
    }
}
