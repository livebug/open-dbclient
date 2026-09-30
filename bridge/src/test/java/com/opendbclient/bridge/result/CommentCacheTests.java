package com.opendbclient.bridge.result;

import java.util.HashMap;
import java.util.Map;

import com.opendbclient.bridge.Assert;
import com.opendbclient.bridge.TestRunner;

/**
 * Tests for the column-comment cache.
 *
 * The cache exists because one of the two things it can store is expensive: on the drivers this feature
 * was written for, reading a table's comments takes seconds, and paying that on every re-run of the same
 * query would be the whole cost of using the tool. So the properties worth pinning down are the two that
 * decide whether it is ever consulted at all - an empty answer is remembered as an answer, and the map
 * cannot grow without limit - plus the one that decides what it keeps: the oldest entry goes, not the
 * least read.
 */
public final class CommentCacheTests {

    private CommentCacheTests() {
    }

    public static void register(TestRunner runner) {
        runner.test("a table with no comments is remembered as answered", CommentCacheTests::emptyIsAnAnswer);
        runner.test("the cache is bounded, and drops the least recently used", CommentCacheTests::evictsLeastRecentlyUsed);
        runner.test("nothing is returned for a table that was never read", CommentCacheTests::absentIsNull);
    }

    private static Map<String, String> comments(String... names) {
        Map<String, String> map = new HashMap<>();
        for (String name : names) {
            map.put(name, "comment of " + name);
        }
        return map;
    }

    private static void emptyIsAnAnswer() {
        CommentCache cache = new CommentCache(8);
        cache.put("c|url|t", Map.of());

        // Null means "not read yet", so an empty table must be stored as an empty map: remembering it as
        // nothing would send every later query back to the slow call this cache exists to avoid.
        Assert.notNull(cache.get("c|url|t"), "an empty answer is still an answer");
        Assert.equal(0, cache.get("c|url|t").size(), "and it says there are no comments");
        Assert.isNull(cache.get("c|url|other"), "a table that was never read is unknown");
    }

    private static void absentIsNull() {
        Assert.isNull(new CommentCache(4).get("never|called"), "an empty cache knows nothing");
    }

    private static void evictsLeastRecentlyUsed() {
        CommentCache cache = new CommentCache(3);
        cache.put("a", comments("ID"));
        cache.put("b", comments("ID"));
        cache.put("c", comments("ID"));

        // Reading `a` is what makes it the one worth keeping: the tables somebody keeps querying are the
        // ones whose lookup should not be repeated.
        cache.get("a");
        cache.put("d", comments("ID"));

        Assert.notNull(cache.get("a"), "the recently read table survives");
        Assert.isNull(cache.get("b"), "the least recently used one is dropped");
        Assert.notNull(cache.get("c"), "and the other untouched one is still there");
        Assert.equal(3, cache.size(), "the cache stays at its limit");
    }
}
