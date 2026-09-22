package com.opendbclient.bridge.result;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Array;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.NClob;
import java.sql.SQLException;
import java.sql.SQLXML;
import java.sql.Struct;
import java.sql.Timestamp;
import java.time.temporal.TemporalAccessor;
import java.util.ArrayList;
import java.util.List;

import com.opendbclient.bridge.log.Log;

/**
 * Converts JDBC values into something JSON can carry without losing meaning.
 *
 * <p>Three rules drive everything here, and each exists because the obvious alternative is wrong.
 *
 * <h2>Exact numbers travel as strings</h2>
 *
 * JSON numbers become IEEE-754 doubles in JavaScript. A {@code DECIMAL(38,10)} or a {@code BIGINT}
 * beyond 2^53 would come back silently altered - a balance of 9007199254740993 arriving as
 * 9007199254740992 is the kind of bug nobody notices until it matters. Values that cannot be
 * represented exactly are therefore sent as strings, which the grid displays verbatim and the
 * exporter writes unchanged. Types that are inherently approximate - {@code FLOAT},
 * {@code DOUBLE} - stay numeric, because a string would imply a precision they never had.
 *
 * <h2>The protocol payload is capped per cell</h2>
 *
 * A single {@code TEXT} column can hold megabytes. Passing that through untouched would make one
 * row dominate the transfer and could stall the UI on a scroll. Long text is truncated with an
 * explicit marker, and the untouched value remains available through export, which the bridge
 * streams straight to a file.
 *
 * <h2>Binary is described, not shipped</h2>
 *
 * Images, documents and geometry are reported as a size-and-type placeholder. Base64 would triple
 * the payload to display bytes nobody can read, and the export path writes them losslessly.
 */
public final class ValueConverter {

    /** Maximum characters of text carried in one cell. */
    public static final int MAX_TEXT_LENGTH = 65_536;

    /** Largest integer that a JavaScript number represents exactly (2^53 - 1). */
    private static final BigInteger MAX_EXACT_INTEGER = BigInteger.valueOf(9_007_199_254_740_991L);

    private ValueConverter() {
    }

    /**
     * Converts one value from a {@link java.sql.ResultSet}.
     *
     * @return a JSON-friendly value: {@code null}, {@link String}, {@link Boolean}, a {@link Number}
     *         that survives the trip exactly, or a {@link List} for SQL arrays
     */
    public static Object toJsonValue(Object value) throws SQLException {
        if (value == null) {
            return null;
        }

        // Strings and booleans need no interpretation.
        if (value instanceof String text) {
            return truncate(text);
        }
        if (value instanceof Boolean flag) {
            return flag;
        }
        if (value instanceof Character character) {
            return character.toString();
        }

        // Integral types: exact when they fit in a double, otherwise textual.
        if (value instanceof Integer || value instanceof Short || value instanceof Byte) {
            return value;
        }
        if (value instanceof Long longValue) {
            return Math.abs(longValue) <= 9_007_199_254_740_991L ? longValue : longValue.toString();
        }
        if (value instanceof BigInteger bigInteger) {
            return bigInteger.abs().compareTo(MAX_EXACT_INTEGER) <= 0 ? bigInteger.longValue() : bigInteger.toString();
        }

        // Fixed-point: always textual, so scale is preserved and precision is never lost.
        if (value instanceof BigDecimal decimal) {
            return decimal.toPlainString();
        }

        // Floating point: genuinely approximate, so a number is the honest representation.
        if (value instanceof Double || value instanceof Float) {
            double number = ((Number) value).doubleValue();
            if (Double.isNaN(number) || Double.isInfinite(number)) {
                // JSON cannot express these. SQL knows them as 'NaN' and 'Infinity', so say so.
                return String.valueOf(number);
            }
            return number;
        }

        if (value instanceof byte[] bytes) {
            return describeBinary("binary", bytes.length);
        }

        // Date and time types all have stable, round-trippable textual forms.
        if (value instanceof java.sql.Date || value instanceof java.sql.Time
                || value instanceof Timestamp || value instanceof java.util.Date) {
            return value.toString();
        }
        if (value instanceof TemporalAccessor) {
            return value.toString();
        }

        if (value instanceof Blob blob) {
            return describeBinary("blob", safeLength(blob::length));
        }
        if (value instanceof Clob clob) {
            return describeClob(clob);
        }
        if (value instanceof NClob nclob) {
            return describeClob(nclob);
        }
        if (value instanceof SQLXML xml) {
            return truncate(xml.getString());
        }
        if (value instanceof Array array) {
            return convertArray(array);
        }
        if (value instanceof Struct struct) {
            return describeStruct(struct);
        }

        // Drivers are free to hand back vendor types. Their toString is usually meaningful, and
        // producing *something* beats failing the whole row for one unfamiliar column.
        return truncate(String.valueOf(value));
    }

    private static List<Object> convertArray(Array array) throws SQLException {
        Object raw = array.getArray();
        List<Object> result = new ArrayList<>();
        if (raw instanceof Object[] elements) {
            for (Object element : elements) {
                result.add(toJsonValue(element));
            }
            return result;
        }
        // Some drivers return a ResultSet instead of an array for getArray().
        result.add(truncate(String.valueOf(raw)));
        return result;
    }

    private static String describeStruct(Struct struct) {
        // Read the type name up front. Calling it from inside the catch block below would risk
        // throwing from the exception handler itself, replacing a recoverable problem with a
        // failure of the whole row.
        String typeName = "STRUCT";
        try {
            typeName = struct.getSQLTypeName();
        } catch (SQLException failure) {
            Log.debug("Could not read a STRUCT type name: %s", failure.getMessage());
        }

        try {
            Object[] attributes = struct.getAttributes();
            StringBuilder text = new StringBuilder(typeName).append('(');
            for (int i = 0; i < attributes.length; i++) {
                if (i > 0) {
                    text.append(", ");
                }
                text.append(attributes[i]);
            }
            return truncate(text.append(')').toString());
        } catch (SQLException failure) {
            Log.debug("Could not read STRUCT attributes: %s", failure.getMessage());
            return typeName;
        }
    }

    private static String describeClob(Clob clob) {
        try {
            long length = clob.length();
            if (length > MAX_TEXT_LENGTH) {
                // Read only what will be shown; a large CLOB is streamed from the server on demand.
                return truncate(clob.getSubString(1, MAX_TEXT_LENGTH))
                        + truncationMarker(length - MAX_TEXT_LENGTH);
            }
            return truncate(clob.getSubString(1, (int) length));
        } catch (SQLException failure) {
            Log.debug("Could not read a CLOB value: %s", failure.getMessage());
            return describeBinary("clob", -1);
        }
    }

    private static String describeBinary(String kind, long length) {
        return length < 0
                ? "[" + kind + "]"
                : "[" + kind + " " + length + " byte" + (length == 1 ? "" : "s") + ", use Export to save it]";
    }

    private static long safeLength(LengthSupplier supplier) {
        try {
            return supplier.length();
        } catch (SQLException failure) {
            return -1;
        }
    }

    private static String truncate(String text) {
        if (text.length() <= MAX_TEXT_LENGTH) {
            return text;
        }
        return text.substring(0, MAX_TEXT_LENGTH) + truncationMarker(text.length() - MAX_TEXT_LENGTH);
    }

    private static String truncationMarker(long omitted) {
        return "... [" + omitted + " more character" + (omitted == 1 ? "" : "s") + " omitted]";
    }

    /** A value whose length is fetched lazily and may fail. */
    @FunctionalInterface
    private interface LengthSupplier {
        long length() throws SQLException;
    }
}
