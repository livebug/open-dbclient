package com.opendbclient.bridge.json;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Convenience facade over {@link JsonParser} / {@link JsonWriter}.
 *
 * <p>Payloads are modelled with plain Java types ({@code Map}, {@code List}, {@code String},
 * {@code Number}, {@code Boolean}) instead of a bespoke JSON tree. For a request/response
 * bridge this keeps the handlers short, and the typed accessors below re-introduce just
 * enough safety at the boundaries where values are read out of a request.
 */
public final class Json {

    private Json() {
    }

    // ------------------------------------------------------------------
    // parsing / writing
    // ------------------------------------------------------------------

    public static Object parse(String text) {
        return JsonParser.parse(text);
    }

    public static Map<String, Object> parseObject(String text) {
        return JsonParser.parseObject(text);
    }

    public static String write(Object value) {
        return JsonWriter.write(value);
    }

    // ------------------------------------------------------------------
    // builders
    // ------------------------------------------------------------------

    /** Creates an empty, insertion-ordered object. */
    public static Map<String, Object> obj() {
        return new LinkedHashMap<>();
    }

    /** Creates an object from alternating key/value arguments. */
    public static Map<String, Object> obj(Object... keyValuePairs) {
        if (keyValuePairs.length % 2 != 0) {
            throw new IllegalArgumentException("expected an even number of key/value arguments");
        }
        Map<String, Object> result = new LinkedHashMap<>();
        for (int i = 0; i < keyValuePairs.length; i += 2) {
            result.put(String.valueOf(keyValuePairs[i]), keyValuePairs[i + 1]);
        }
        return result;
    }

    public static List<Object> arr() {
        return new ArrayList<>();
    }

    public static List<Object> arr(Object... values) {
        List<Object> result = new ArrayList<>(values.length);
        for (Object value : values) {
            result.add(value);
        }
        return result;
    }

    // ------------------------------------------------------------------
    // typed accessors
    // ------------------------------------------------------------------

    /** Returns the raw value, or {@code null} when absent or explicitly null. */
    public static Object get(Map<String, Object> map, String key) {
        return map == null ? null : map.get(key);
    }

    /** Returns a string value, or {@code fallback} when absent/not a string. */
    public static String str(Map<String, Object> map, String key, String fallback) {
        Object value = get(map, key);
        return value instanceof String text ? text : fallback;
    }

    public static String str(Map<String, Object> map, String key) {
        return str(map, key, null);
    }

    /** Returns a string value, failing when the key is missing. */
    public static String requireStr(Map<String, Object> map, String key) {
        String value = str(map, key);
        if (value == null || value.isEmpty()) {
            throw new JsonException("parameter '" + key + "' is required");
        }
        return value;
    }

    public static boolean bool(Map<String, Object> map, String key, boolean fallback) {
        Object value = get(map, key);
        return value instanceof Boolean flag ? flag.booleanValue() : fallback;
    }

    public static int intValue(Map<String, Object> map, String key, int fallback) {
        Object value = get(map, key);
        if (value instanceof Number number) {
            return number.intValue();
        }
        if (value instanceof String text) {
            try {
                return Integer.parseInt(text.trim());
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    public static long longValue(Map<String, Object> map, String key, long fallback) {
        Object value = get(map, key);
        if (value instanceof Number number) {
            return number.longValue();
        }
        if (value instanceof String text) {
            try {
                return Long.parseLong(text.trim());
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    /** Returns a nested object, never {@code null}. */
    public static Map<String, Object> mapValue(Map<String, Object> map, String key) {
        Object value = get(map, key);
        if (value instanceof Map<?, ?> nested) {
            return toStringKeyedMap(nested);
        }
        return obj();
    }

    /** Returns a nested array, never {@code null}. */
    public static List<Object> listValue(Map<String, Object> map, String key) {
        Object value = get(map, key);
        if (value instanceof List<?> list) {
            return new ArrayList<>(list);
        }
        return new ArrayList<>();
    }

    /** Returns a nested array of strings, skipping entries that are not strings. */
    public static List<String> stringList(Map<String, Object> map, String key) {
        List<String> result = new ArrayList<>();
        for (Object element : listValue(map, key)) {
            if (element instanceof String text && !text.isEmpty()) {
                result.add(text);
            }
        }
        return result;
    }

    /** Copies a map whose keys are unknown statically into a {@code String}-keyed map. */
    public static Map<String, Object> toStringKeyedMap(Map<?, ?> source) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : source.entrySet()) {
            result.put(String.valueOf(entry.getKey()), entry.getValue());
        }
        return result;
    }

    /**
     * Coerces a number to a long without losing precision, tolerating the
     * {@link BigDecimal} / {@link BigInteger} forms the parser may produce.
     */
    public static Long asLong(Object value) {
        if (value instanceof Number number) {
            return number.longValue();
        }
        if (value instanceof String text) {
            try {
                return Long.parseLong(text.trim());
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }
}
