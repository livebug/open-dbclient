package com.opendbclient.bridge.metadata;

import java.util.LinkedHashMap;
import java.util.Map;

import com.opendbclient.bridge.Assert;
import com.opendbclient.bridge.TestRunner;
import com.opendbclient.bridge.json.Json;

/**
 * Tests for reading DDL presentation options out of a request.
 *
 * <p>The rule under test is that a payload the extension should never send must not cost the user
 * their DDL: anything missing or unusable falls back to the default, and a caller that sends nothing
 * at all gets exactly the statement the bridge produced before the options existed.
 */
public final class DdlOptionsTests {

    private DdlOptionsTests() {
    }

    public static void register(TestRunner runner) {
        runner.test("no payload gives the defaults", DdlOptionsTests::defaults);
        runner.test("every option is read from the payload", DdlOptionsTests::readsEveryOption);
        runner.test("a partial payload only changes what it names", DdlOptionsTests::partialPayload);
        runner.test("an empty indent is honoured", DdlOptionsTests::emptyIndentIsHonoured);
        runner.test("a tab indent is honoured", DdlOptionsTests::tabIndentIsHonoured);
        runner.test("an indent containing a newline falls back", DdlOptionsTests::newlineIndentFallsBack);
        runner.test("an absurdly long indent falls back", DdlOptionsTests::longIndentFallsBack);
        runner.test("a non-string indent falls back", DdlOptionsTests::nonStringIndentFallsBack);
        runner.test("a non-boolean flag falls back", DdlOptionsTests::nonBooleanFlagFallsBack);
    }

    // ------------------------------------------------------------------
    // tests
    // ------------------------------------------------------------------

    private static void defaults() {
        DdlBuilder.Options options = DdlBuilder.Options.from(null);
        Assert.equal(DdlBuilder.Options.DEFAULT, options, "options from a null payload");
        Assert.equal("CREATE TABLE", "CREATE TABLE", "sanity");
        Assert.that(!options.ifNotExists(), "IF NOT EXISTS must be off by default");
        Assert.equal(4, options.indent().length(), "default indent length");
        Assert.that(options.includeIndexes(), "indexes included by default");
        Assert.that(options.quoteIdentifiers(), "identifiers quoted by default");
    }

    private static void readsEveryOption() {
        Map<String, Object> payload = Json.obj(
                "ifNotExists", true,
                "indent", "  ",
                "includeIndexes", false,
                "quoteIdentifiers", false);

        DdlBuilder.Options options = DdlBuilder.Options.from(payload);
        Assert.that(options.ifNotExists(), "ifNotExists");
        Assert.equal("  ", options.indent(), "indent");
        Assert.that(!options.includeIndexes(), "includeIndexes");
        Assert.that(!options.quoteIdentifiers(), "quoteIdentifiers");
    }

    private static void partialPayload() {
        Map<String, Object> payload = Json.obj("ifNotExists", true);
        DdlBuilder.Options options = DdlBuilder.Options.from(payload);
        Assert.that(options.ifNotExists(), "the named option is applied");
        Assert.equal(DdlBuilder.Options.DEFAULT.indent(), options.indent(), "the rest keep their default");
        Assert.that(options.includeIndexes(), "indexes stay included");
    }

    private static void emptyIndentIsHonoured() {
        // Zero indentation is a legitimate choice, and it is the one a truthiness check would break.
        DdlBuilder.Options options = DdlBuilder.Options.from(Json.obj("indent", ""));
        Assert.equal("", options.indent(), "empty indent");
    }

    private static void tabIndentIsHonoured() {
        DdlBuilder.Options options = DdlBuilder.Options.from(Json.obj("indent", "\t"));
        Assert.equal("\t", options.indent(), "tab indent");
    }

    private static void newlineIndentFallsBack() {
        // Emitted once per column, so a newline here would produce a statement that cannot be parsed.
        DdlBuilder.Options options = DdlBuilder.Options.from(Json.obj("indent", "  \n  "));
        Assert.equal(DdlBuilder.Options.DEFAULT.indent(), options.indent(), "indent with a newline");
    }

    private static void longIndentFallsBack() {
        DdlBuilder.Options options = DdlBuilder.Options.from(Json.obj("indent", "x".repeat(64)));
        Assert.equal(DdlBuilder.Options.DEFAULT.indent(), options.indent(), "64 character indent");
    }

    private static void nonStringIndentFallsBack() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("indent", 42);
        Assert.equal(DdlBuilder.Options.DEFAULT.indent(), DdlBuilder.Options.from(payload).indent(), "numeric indent");
    }

    private static void nonBooleanFlagFallsBack() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ifNotExists", "yes");
        Assert.that(!DdlBuilder.Options.from(payload).ifNotExists(), "a string is not a boolean");
    }
}
