package com.opendbclient.bridge.health;

import java.util.List;
import java.util.Map;

import com.opendbclient.bridge.Assert;
import com.opendbclient.bridge.TestRunner;

/**
 * Tests for the metadata timings.
 *
 * This exists to answer one question: "which read is making this slow?". So the properties are the ones
 * that make an answer possible - a call is totalled across the session, a failure is told apart from a
 * success, the individual reads are kept with the object they were about, and the list of them cannot grow
 * for the life of the process.
 */
public final class MetadataMetricsTests {

    private MetadataMetricsTests() {
    }

    public static void register(TestRunner runner) {
        runner.test("a call is totalled across the session", MetadataMetricsTests::totalsPerCall);
        runner.test("the busiest total comes first, not the most frequent call", MetadataMetricsTests::sortedByTotalTime);
        runner.test("a failure is counted as one, and remembered as failed", MetadataMetricsTests::failuresAreCounted);
        runner.test("only the slowest reads are kept, heaviest first", MetadataMetricsTests::slowestIsBounded);
        runner.test("nothing has been read yet", MetadataMetricsTests::emptyPayload);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> calls(MetadataMetrics metrics) {
        return (List<Map<String, Object>>) metrics.payload().get("calls");
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> slowest(MetadataMetrics metrics) {
        return (List<Map<String, Object>>) metrics.payload().get("slowest");
    }

    private static void totalsPerCall() {
        MetadataMetrics metrics = new MetadataMetrics();
        metrics.record("conn", "columns", "public.orders", 300L, true);
        metrics.record("conn", "columns", "public.items", 100L, true);
        metrics.record("conn", "tables", "public", 20L, true);

        List<Map<String, Object>> calls = calls(metrics);
        Assert.equal(2, calls.size(), "one entry per kind of read");

        Map<String, Object> columns = calls.get(0);
        Assert.equal("columns", columns.get("call"), "the heaviest call is reported first");
        Assert.equal(2L, columns.get("count"), "both column reads are counted");
        Assert.equal(400L, columns.get("millis"), "and their time is added up");
        Assert.equal(200L, columns.get("averageMillis"), "the average is over the reads, not the calls");
        Assert.equal(0L, columns.get("failures"), "neither failed");
    }

    private static void sortedByTotalTime() {
        MetadataMetrics metrics = new MetadataMetrics();
        // A hundred fast calls must not outrank one slow one: the question is where the time went.
        for (int i = 0; i < 100; i++) {
            metrics.record("conn", "tableTypes", "", 1L, true);
        }
        metrics.record("conn", "columns", "public.orders", 5_000L, true);

        Assert.equal("columns", calls(metrics).get(0).get("call"), "the slow one is the answer");
        Assert.equal("tableTypes", calls(metrics).get(1).get("call"), "the frequent one follows");
    }

    private static void failuresAreCounted() {
        MetadataMetrics metrics = new MetadataMetrics();
        metrics.record("conn", "columns", "public.broken", 8L, false);

        Map<String, Object> entry = calls(metrics).get(0);
        Assert.equal(1L, entry.get("count"), "a failed read still happened");
        Assert.equal(1L, entry.get("failures"), "and is counted as a failure");
        Assert.equal(Boolean.FALSE, slowest(metrics).get(0).get("succeeded"), "the read is marked failed");
        Assert.equal("public.broken", slowest(metrics).get(0).get("subject"), "and names its object");
    }

    private static void slowestIsBounded() {
        MetadataMetrics metrics = new MetadataMetrics();
        for (int i = 1; i <= 40; i++) {
            metrics.record("conn", "columns", "t" + i, i, true);
        }

        List<Map<String, Object>> slowest = slowest(metrics);
        Assert.equal(20, slowest.size(), "the list is capped");
        Assert.equal(40L, slowest.get(0).get("millis"), "the slowest read is first");
        Assert.equal(21L, slowest.get(19).get("millis"), "and the fastest remembered one is last");

        // The totals are unaffected by the cap: dropping a read from the list must not lose its time.
        Assert.equal(40L, calls(metrics).get(0).get("count"), "every read is still counted");
    }

    private static void emptyPayload() {
        Map<String, Object> payload = new MetadataMetrics().payload();
        Assert.equal(0, ((List<?>) payload.get("calls")).size(), "no calls");
        Assert.equal(0, ((List<?>) payload.get("slowest")).size(), "and nothing slow");
    }
}
