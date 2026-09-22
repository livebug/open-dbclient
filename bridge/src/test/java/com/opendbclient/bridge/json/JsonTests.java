package com.opendbclient.bridge.json;

import java.math.BigInteger;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import com.opendbclient.bridge.Assert;
import com.opendbclient.bridge.TestRunner;

/**
 * Tests for the hand-written JSON codec.
 *
 * <p>This codec is the seam every request and response passes through, and it is the one
 * place in the bridge where a subtle bug corrupts everything rather than one feature. The
 * cases below lean on edge conditions that only show up under real database workloads:
 * surrogate pairs from emoji in table comments, control characters inside string data,
 * integers wider than a long, and non-finite doubles that JSON cannot represent.
 */
public final class JsonTests {

    /**
     * A single backslash, referenced rather than inlined.
     *
     * Java processes unicode escapes during lexing, before comments and string literals are
     * interpreted, so source text containing a lone backslash followed by {@code u} is a
     * compile error even inside a string. Building escape sequences from this constant keeps
     * the test inputs unambiguous.
     */
    private static final String BS = "\\";

    private JsonTests() {
    }

    public static void register(TestRunner runner) {
        runner.test("parses nested objects and arrays", JsonTests::nestedContainers);
        runner.test("parses simple scalar values", JsonTests::scalars);
        runner.test("decodes escape sequences", JsonTests::escapeSequences);
        runner.test("decodes unicode escapes including surrogate pairs", JsonTests::unicodeEscapes);
        runner.test("parses integer, oversized and floating point numbers", JsonTests::numbers);
        runner.test("tolerates insignificant whitespace", JsonTests::whitespace);
        runner.test("parses empty containers", JsonTests::emptyContainers);
        runner.test("duplicate keys keep the last value", JsonTests::duplicateKeys);
        runner.test("rejects malformed documents", JsonTests::malformedDocuments);
        runner.test("writes scalars with correct escaping", JsonTests::writeScalars);
        runner.test("writes non-ASCII text without escaping it", JsonTests::writeUnicode);
        runner.test("writes non-finite numbers as null", JsonTests::writeNonFinite);
        runner.test("writes nested containers", JsonTests::writeContainers);
        runner.test("stringifies unknown types instead of failing", JsonTests::writeUnknownType);
        runner.test("round-trips a complex document", JsonTests::roundTrip);
        runner.test("typed accessors apply defaults", JsonTests::accessorDefaults);
        runner.test("required accessor rejects missing values", JsonTests::accessorRequired);
        runner.test("string list accessor skips non-string entries", JsonTests::stringListFiltering);
    }

    // ------------------------------------------------------------------
    // parsing
    // ------------------------------------------------------------------

    private static void nestedContainers() {
        Map<String, Object> root = Json.parseObject("{\"a\":{\"b\":[1,2,{\"c\":true}]},\"d\":null}");

        Map<String, Object> a = Json.mapValue(root, "a");
        List<Object> b = Json.listValue(a, "b");
        Assert.equal(3, b.size(), "array length");

        Map<String, Object> c = Json.toStringKeyedMap(requireMap(b.get(2), "third array element"));
        Assert.equal(Boolean.TRUE, c.get("c"), "nested boolean");

        Assert.that(root.containsKey("d"), "'d' key present");
        Assert.isNull(root.get("d"), "explicit null value");
    }

    private static void scalars() {
        Assert.equal(Boolean.TRUE, Json.parse("true"), "true");
        Assert.equal(Boolean.FALSE, Json.parse("false"), "false");
        Assert.isNull(Json.parse("null"), "null");
        Assert.equal("hi", Json.parse("\"hi\""), "string");
    }

    private static void escapeSequences() {
        String json = "\"a" + BS + "nb" + BS + "tc" + BS + "\"d" + BS + BS + "e" + BS + "/f\"";
        Assert.equal("a\nb\tc\"d\\e/f", Json.parse(json), "named escapes and slash");

        String control = "\"x" + BS + "by" + BS + "fz" + BS + "rw\"";
        Assert.equal("x\by\fz\rw", Json.parse(control), "backspace, formfeed and carriage return");
    }

    private static void unicodeEscapes() {
        String cjk = "\"" + BS + "u4e2d" + BS + "u6587\"";
        Assert.equal("中文", Json.parse(cjk), "BMP unicode escapes");

        // U+1F600 encoded as a surrogate pair, which is how JSON carries astral characters.
        String emoji = new String(Character.toChars(0x1F600));
        String pair = "\"" + BS + "ud83d" + BS + "ude00\"";
        Assert.equal(emoji, Json.parse(pair), "surrogate pair");
    }

    private static void numbers() {
        Assert.equal(Long.valueOf(123L), Json.parse("123"), "integer");
        Assert.equal(Long.valueOf(-42L), Json.parse("-42"), "negative integer");
        Assert.equal(Long.valueOf(0L), Json.parse("0"), "zero");
        Assert.equal(Double.valueOf(1.5), Json.parse("1.5"), "decimal");
        Assert.equal(Double.valueOf(1000.0), Json.parse("1e3"), "lowercase exponent");
        Assert.equal(Double.valueOf(1000.0), Json.parse("1E3"), "uppercase exponent");
        Assert.equal(Double.valueOf(0.0015), Json.parse("1.5e-3"), "negative exponent");

        Object huge = Json.parse("123456789012345678901234567890");
        Assert.that(huge instanceof BigInteger,
                "integers beyond long range should become BigInteger but were " + huge.getClass().getName());
    }

    private static void whitespace() {
        Map<String, Object> root = Json.parseObject("  {\n\t\"a\" : [ 1 ,\r\n 2 ]  }  ");
        Assert.equal(2, Json.listValue(root, "a").size(), "array length after whitespace");
    }

    private static void emptyContainers() {
        Assert.equal(0, Json.parseObject("{}").size(), "empty object");
        Assert.equal(0, Json.parseObject("{ }").size(), "empty object with whitespace");
        Assert.equal(0, ((List<?>) Json.parse("[]")).size(), "empty array");
    }

    private static void duplicateKeys() {
        Assert.equal(Long.valueOf(2L), Json.parseObject("{\"a\":1,\"a\":2}").get("a"), "last value wins");
    }

    private static void malformedDocuments() {
        expectReject("{\"a\":}", "missing value");
        expectReject("{\"a\":1", "unterminated object");
        expectReject("[1,2", "unterminated array");
        expectReject("\"abc", "unterminated string");
        expectReject("{\"a\" 1}", "missing colon");
        expectReject("{\"a\":1} trailing", "trailing content");
        expectReject("\"" + BS + "q\"", "invalid escape");
        expectReject("\"" + BS + "u00zz\"", "invalid hex digits in unicode escape");
        expectReject("\"" + BS + "u12\"", "truncated unicode escape");
        expectReject("\"a" + ((char) 1) + "b\"", "raw control character inside a string");
        expectReject("", "empty input");
        expectReject("42", "top-level scalar where an object is required", true);
    }

    // ------------------------------------------------------------------
    // writing
    // ------------------------------------------------------------------

    private static void writeScalars() {
        Assert.equal("\"hi\"", Json.write("hi"), "plain string");
        Assert.equal("\"" + BS + "n\"", Json.write("\n"), "newline");
        Assert.equal("\"" + BS + "\"\"", Json.write("\""), "double quote");
        Assert.equal("\"" + BS + BS + "\"", Json.write("\\"), "backslash");
        Assert.equal("\"" + BS + "u0007\"", Json.write(String.valueOf((char) 7)), "control character");
        Assert.equal("true", Json.write(Boolean.TRUE), "boolean true");
        Assert.equal("null", Json.write(null), "null");
        Assert.equal("42", Json.write(42), "integer");
        Assert.equal("1.5", Json.write(1.5), "double");
    }

    private static void writeUnicode() {
        Assert.equal("\"用户表\"", Json.write("用户表"), "CJK is emitted verbatim");
        Assert.equal("\"café\"", Json.write("café"), "accented latin is emitted verbatim");
    }

    private static void writeNonFinite() {
        Assert.equal("null", Json.write(Double.NaN), "NaN has no JSON form");
        Assert.equal("null", Json.write(Double.POSITIVE_INFINITY), "positive infinity");
        Assert.equal("null", Json.write(Float.NEGATIVE_INFINITY), "negative infinity from a float");
    }

    private static void writeContainers() {
        Map<String, Object> nested = Json.obj(
                "a", Json.arr(1, "two", null),
                "b", Json.obj("c", Boolean.TRUE));
        Assert.equal("{\"a\":[1,\"two\",null],\"b\":{\"c\":true}}", Json.write(nested), "nested containers");
    }

    private static void writeUnknownType() {
        // StringBuilder is neither a Number nor an Iterable, so it exercises the final
        // fallback. Numbers are matched earlier, which is why AtomicInteger would not work
        // here - it extends Number and is intentionally emitted as a bare number.
        Assert.equal("\"abc\"", Json.write(new StringBuilder("abc")),
                "an unknown type should be stringified rather than fail the response");
        Assert.equal("5", Json.write(new AtomicInteger(5)),
                "Number subclasses are emitted as numbers, not strings");
    }

    private static void roundTrip() {
        Map<String, Object> original = Json.obj(
                "text", "值 with \"quotes\" and " + BS + " backslash",
                "list", Json.arr(1L, 2.5, Boolean.FALSE, null, Json.obj("deep", "中文")),
                "empty", Json.obj());

        String encoded = Json.write(original);
        Map<String, Object> decoded = Json.parseObject(encoded);

        // Encoding must be idempotent: decode(encode(x)) re-encodes to the same bytes. This
        // catches asymmetries between the reader and the writer that a plain value comparison
        // would miss, such as numbers changing representation across a round trip.
        Assert.equal(encoded, Json.write(decoded), "re-encoding the decoded document is stable");
    }

    // ------------------------------------------------------------------
    // typed accessors
    // ------------------------------------------------------------------

    private static void accessorDefaults() {
        Map<String, Object> params = Json.obj("present", "yes", "count", 3, "flag", Boolean.TRUE);

        Assert.equal("yes", Json.str(params, "present"), "present string");
        Assert.equal("fallback", Json.str(params, "absent", "fallback"), "absent string uses default");
        Assert.equal(3, Json.intValue(params, "count", 0), "present integer");
        Assert.equal(7, Json.intValue(params, "absent", 7), "absent integer uses default");
        Assert.equal(Boolean.TRUE, Json.bool(params, "flag", false), "present boolean");
        Assert.equal(Boolean.TRUE, Json.bool(params, "absent", true), "absent boolean uses default");
        Assert.equal(0, Json.mapValue(params, "absent").size(), "absent object is empty");
        Assert.equal(0, Json.listValue(params, "absent").size(), "absent array is empty");

        Assert.equal(9, Json.intValue(Json.obj("s", "9"), "s", 0), "numeric string is coerced");
        Assert.equal(4, Json.intValue(Json.obj("s", "nope"), "s", 4), "unparseable string falls back");
    }

    private static void accessorRequired() {
        Assert.throwsError(JsonException.class,
                () -> Json.requireStr(Json.obj(), "missing"), "missing required string");
        Assert.throwsError(JsonException.class,
                () -> Json.requireStr(Json.obj("empty", ""), "empty"), "blank required string");
    }

    private static void stringListFiltering() {
        Map<String, Object> params = Json.obj("items", Json.arr("a", 1, "", "b", null));
        Assert.equal(List.of("a", "b"), Json.stringList(params, "items"),
                "non-strings and blanks are dropped");
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private static void expectReject(String json, String what) {
        expectReject(json, what, false);
    }

    private static void expectReject(String json, String what, boolean requireObject) {
        Assert.throwsError(JsonException.class, () -> {
            if (requireObject) {
                Json.parseObject(json);
            } else {
                Json.parse(json);
            }
        }, what);
    }

    private static Map<?, ?> requireMap(Object value, String what) {
        Assert.that(value instanceof Map, what + " should be an object but was " + value);
        return (Map<?, ?>) value;
    }
}
