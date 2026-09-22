package com.opendbclient.bridge.json;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A small, dependency-free JSON reader.
 *
 * <p>The JDBC bridge deliberately avoids third-party libraries. Everything the bridge
 * needs from JSON is covered here, and keeping it in-tree means the bridge jar has no
 * transitive dependencies that could clash with a user-supplied driver jar (many
 * database drivers ship ancient copies of common libraries on their classpath).
 *
 * <p>Mapping rules:
 * <ul>
 *   <li>object &rarr; {@link LinkedHashMap} (insertion order preserved)</li>
 *   <li>array &rarr; {@link ArrayList}</li>
 *   <li>string &rarr; {@link String}</li>
 *   <li>integer literal &rarr; {@link Long}, or {@link BigInteger} when it overflows</li>
 *   <li>fractional/exponent literal &rarr; {@link Double}</li>
 *   <li>true/false &rarr; {@link Boolean}, null &rarr; {@code null}</li>
 * </ul>
 */
public final class JsonParser {

    private final String src;
    private int pos;

    private JsonParser(String src) {
        this.src = src;
    }

    /**
     * Parses a complete JSON document.
     *
     * @throws JsonException if the text is malformed or has trailing content
     */
    public static Object parse(String text) {
        JsonParser parser = new JsonParser(text);
        parser.skipWhitespace();
        Object value = parser.readValue();
        parser.skipWhitespace();
        if (parser.pos < parser.src.length()) {
            throw parser.error("unexpected trailing content");
        }
        return value;
    }

    /**
     * Parses JSON text that must be an object.
     *
     * @throws JsonException if the document is not an object
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String text) {
        Object value = parse(text);
        if (!(value instanceof Map)) {
            throw new JsonException("expected a JSON object at the top level");
        }
        return (Map<String, Object>) value;
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    private Object readValue() {
        if (pos >= src.length()) {
            throw error("unexpected end of input");
        }
        char c = src.charAt(pos);
        switch (c) {
            case '{':
                return readObject();
            case '[':
                return readArray();
            case '"':
                return readString();
            case 't':
                expectLiteral("true");
                return Boolean.TRUE;
            case 'f':
                expectLiteral("false");
                return Boolean.FALSE;
            case 'n':
                expectLiteral("null");
                return null;
            default:
                return readNumber();
        }
    }

    private Map<String, Object> readObject() {
        Map<String, Object> result = new LinkedHashMap<>();
        pos++; // consume '{'
        skipWhitespace();
        if (peek() == '}') {
            pos++;
            return result;
        }
        while (true) {
            skipWhitespace();
            if (peek() != '"') {
                throw error("expected a string key");
            }
            String key = readString();
            skipWhitespace();
            if (peek() != ':') {
                throw error("expected ':' after key");
            }
            pos++;
            skipWhitespace();
            result.put(key, readValue());
            skipWhitespace();
            char next = peek();
            if (next == ',') {
                pos++;
            } else if (next == '}') {
                pos++;
                return result;
            } else {
                throw error("expected ',' or '}' in object");
            }
        }
    }

    private List<Object> readArray() {
        List<Object> result = new ArrayList<>();
        pos++; // consume '['
        skipWhitespace();
        if (peek() == ']') {
            pos++;
            return result;
        }
        while (true) {
            skipWhitespace();
            result.add(readValue());
            skipWhitespace();
            char next = peek();
            if (next == ',') {
                pos++;
            } else if (next == ']') {
                pos++;
                return result;
            } else {
                throw error("expected ',' or ']' in array");
            }
        }
    }

    private String readString() {
        pos++; // consume opening quote
        StringBuilder out = new StringBuilder();
        while (true) {
            if (pos >= src.length()) {
                throw error("unterminated string");
            }
            char c = src.charAt(pos++);
            if (c == '"') {
                return out.toString();
            }
            if (c == '\\') {
                if (pos >= src.length()) {
                    throw error("unterminated escape sequence");
                }
                char esc = src.charAt(pos++);
                switch (esc) {
                    case '"' -> out.append('"');
                    case '\\' -> out.append('\\');
                    case '/' -> out.append('/');
                    case 'b' -> out.append('\b');
                    case 'f' -> out.append('\f');
                    case 'n' -> out.append('\n');
                    case 'r' -> out.append('\r');
                    case 't' -> out.append('\t');
                    case 'u' -> out.append(readUnicodeEscape());
                    default -> throw error("invalid escape '\\" + esc + "'");
                }
            } else if (c < 0x20) {
                throw error("control character U+" + String.format("%04X", (int) c)
                        + " must be escaped in a string");
            } else {
                out.append(c);
            }
        }
    }

    /**
     * Reads the four hex digits following a unicode escape and returns the resulting
     * character. Surrogate pairs arrive as two consecutive escapes, which Java's UTF-16
     * {@code String} represents natively.
     *
     * <p>Note for maintainers: the escape introducer cannot be written literally in a
     * comment here. Java processes unicode escapes during lexing, before comments are
     * stripped, so a lone backslash followed by {@code u} is an error even inside Javadoc.
     */
    private char readUnicodeEscape() {
        if (pos + 4 > src.length()) {
            throw error("truncated \\u escape");
        }
        int value = 0;
        for (int i = 0; i < 4; i++) {
            char c = src.charAt(pos++);
            int digit = Character.digit(c, 16);
            if (digit < 0) {
                throw error("invalid hex digit '" + c + "' in \\u escape");
            }
            value = (value << 4) | digit;
        }
        return (char) value;
    }

    private Object readNumber() {
        int start = pos;
        if (peek() == '-' || peek() == '+') {
            pos++;
        }
        boolean fractional = false;
        while (pos < src.length()) {
            char c = src.charAt(pos);
            if (c >= '0' && c <= '9') {
                pos++;
            } else if (c == '.' || c == 'e' || c == 'E') {
                fractional = true;
                pos++;
            } else if ((c == '-' || c == '+') && pos > start
                    && (src.charAt(pos - 1) == 'e' || src.charAt(pos - 1) == 'E')) {
                pos++;
            } else {
                break;
            }
        }
        String literal = src.substring(start, pos);
        if (literal.isEmpty() || literal.equals("-") || literal.equals("+")) {
            throw error("invalid number");
        }
        if (!fractional) {
            try {
                return Long.valueOf(literal);
            } catch (NumberFormatException overflow) {
                try {
                    return new BigInteger(literal);
                } catch (NumberFormatException notANumber) {
                    throw error("invalid number '" + literal + "'");
                }
            }
        }
        try {
            return Double.valueOf(literal);
        } catch (NumberFormatException notANumber) {
            throw error("invalid number '" + literal + "'");
        }
    }

    private void expectLiteral(String literal) {
        if (!src.startsWith(literal, pos)) {
            throw error("expected '" + literal + "'");
        }
        pos += literal.length();
    }

    private char peek() {
        if (pos >= src.length()) {
            throw error("unexpected end of input");
        }
        return src.charAt(pos);
    }

    private void skipWhitespace() {
        while (pos < src.length()) {
            char c = src.charAt(pos);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                pos++;
            } else {
                break;
            }
        }
    }

    private JsonException error(String message) {
        int line = 1;
        int column = 1;
        for (int i = 0; i < Math.min(pos, src.length()); i++) {
            if (src.charAt(i) == '\n') {
                line++;
                column = 1;
            } else {
                column++;
            }
        }
        return new JsonException(message, line, column);
    }
}
