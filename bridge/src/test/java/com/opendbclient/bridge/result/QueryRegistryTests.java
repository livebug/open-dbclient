package com.opendbclient.bridge.result;

import java.util.List;
import java.util.Map;

import com.opendbclient.bridge.Assert;
import com.opendbclient.bridge.TestRunner;

/**
 * Tests for the recent-statement list.
 *
 * The list exists so that somebody looking at the health panel can see which SQL the bridge has been
 * running, including the one that failed. Its two interesting properties are cheap to state and easy to
 * get wrong: it must be bounded, because it is fed by every statement for the life of the process, and it
 * must not lose the outcome, because that is what makes it useful when something went wrong.
 */
public final class QueryRegistryTests {

    private QueryRegistryTests() {
    }

    public static void register(TestRunner runner) {
        runner.test("statements are listed newest first", QueryRegistryTests::newestFirst);
        runner.test("the list is bounded", QueryRegistryTests::bounded);
        runner.test("a failure is recorded with its outcome", QueryRegistryTests::failureIsRecorded);
        runner.test("an empty registry says nothing", QueryRegistryTests::emptyIsEmpty);
    }

    private static void newestFirst() {
        try (QueryRegistry registry = new QueryRegistry()) {
            registry.recordStatement("conn", "SELECT 1", 10L, 1L, true);
            registry.recordStatement("conn", "SELECT 2", 20L, 2L, true);

            List<Map<String, Object>> recent = registry.recentStatementsPayload();
            Assert.equal(2, recent.size(), "two statements");
            Assert.equal("SELECT 2", recent.get(0).get("sql"), "the last one run comes first");
            Assert.equal("SELECT 1", recent.get(1).get("sql"), "and the earlier one follows");
        }
    }

    private static void bounded() {
        try (QueryRegistry registry = new QueryRegistry()) {
            for (int i = 1; i <= 40; i++) {
                registry.recordStatement("conn", "SELECT " + i, 1L, 1L, true);
            }

            List<Map<String, Object>> recent = registry.recentStatementsPayload();
            Assert.equal(20, recent.size(), "the list is capped");
            Assert.equal("SELECT 40", recent.get(0).get("sql"), "the newest survives");
            // The oldest twenty are gone; the boundary is what a bug in the trimming loop would get wrong.
            Assert.equal("SELECT 21", recent.get(19).get("sql"), "the oldest kept is the twentieth from the end");
        }
    }

    private static void failureIsRecorded() {
        try (QueryRegistry registry = new QueryRegistry()) {
            registry.recordStatement("conn", "SELECT broken", 5L, -1L, false);

            Map<String, Object> entry = registry.recentStatementsPayload().get(0);
            Assert.equal(Boolean.FALSE, entry.get("succeeded"), "the failure is recorded as one");
            Assert.equal(-1L, entry.get("rows"), "a statement without a row count says so");
            Assert.equal("conn", entry.get("connectionId"), "the connection is kept");
            Assert.notNull(entry.get("timestamp"), "and so is when it ran");
        }
    }

    private static void emptyIsEmpty() {
        try (QueryRegistry registry = new QueryRegistry()) {
            Assert.equal(0, registry.recentStatementsPayload().size(), "nothing has run yet");
        }
    }
}
