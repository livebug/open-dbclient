package com.opendbclient.bridge.json;

import java.lang.reflect.Array;
import java.util.Map;

/**
 * A small, dependency-free JSON writer.
 *
 * <p>Output is UTF-8 friendly: non-ASCII characters are emitted as-is rather than as
 * {@code \\u} escapes, because the bridge controls its own stream encoding and the raw
 * form keeps CJK data readable when debugging the protocol by hand.
 *
 * <p>Values of unknown type fall back to their {@code toString()} wrapped in a string.
 * A bridge must never fail an entire response just because a driver returned an exotic
 * value type.
 */
public final class JsonWriter {

    private JsonWriter() {
    }

    /** Serialises a value to compact JSON text. */
    public static String write(Object value) {
        StringBuilder out = new StringBuilder(256);
        writeTo(value, out);
        return out.toString();
    }

    /** Appends the JSON form of {@code value} to {@code out}. */
    public static void writeTo(Object value, StringBuilder out) {
        if (value == null) {
            out.append("null");
            return;
        }
        if (value instanceof String text) {
            writeString(text, out);
            return;
        }
        if (value instanceof Boolean flag) {
            out.append(flag.booleanValue() ? "true" : "false");
            return;
        }
        if (value instanceof Double || value instanceof Float) {
            double number = ((Number) value).doubleValue();
            // JSON has no way to express these, and emitting them would produce
            // text that JSON.parse() rejects outright.
            if (Double.isNaN(number) || Double.isInfinite(number)) {
                out.append("null");
            } else {
                out.append(number);
            }
            return;
        }
        if (value instanceof Number number) {
            out.append(number.toString());
            return;
        }
        if (value instanceof Character c) {
            writeString(c.toString(), out);
            return;
        }
        if (value instanceof Enum<?> enumValue) {
            writeString(enumValue.name(), out);
            return;
        }
        if (value instanceof Map<?, ?> map) {
            writeObject(map, out);
            return;
        }
        if (value instanceof Iterable<?> iterable) {
            writeArray(iterable, out);
            return;
        }
        if (value.getClass().isArray()) {
            writeNativeArray(value, out);
            return;
        }
        // Unknown type: stringify rather than fail the whole response.
        writeString(value.toString(), out);
    }

    private static void writeObject(Map<?, ?> map, StringBuilder out) {
        out.append('{');
        boolean first = true;
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (!first) {
                out.append(',');
            }
            first = false;
            writeString(String.valueOf(entry.getKey()), out);
            out.append(':');
            writeTo(entry.getValue(), out);
        }
        out.append('}');
    }

    private static void writeArray(Iterable<?> iterable, StringBuilder out) {
        out.append('[');
        boolean first = true;
        for (Object element : iterable) {
            if (!first) {
                out.append(',');
            }
            first = false;
            writeTo(element, out);
        }
        out.append(']');
    }

    private static void writeNativeArray(Object array, StringBuilder out) {
        out.append('[');
        int length = Array.getLength(array);
        for (int i = 0; i < length; i++) {
            if (i > 0) {
                out.append(',');
            }
            writeTo(Array.get(array, i), out);
        }
        out.append(']');
    }

    private static void writeString(String text, StringBuilder out) {
        out.append('"');
        int length = text.length();
        for (int i = 0; i < length; i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        out.append("\\u");
                        String hex = Integer.toHexString(c);
                        for (int pad = hex.length(); pad < 4; pad++) {
                            out.append('0');
                        }
                        out.append(hex);
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }
}
