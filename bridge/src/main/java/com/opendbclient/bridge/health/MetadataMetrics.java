package com.opendbclient.bridge.health;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import com.opendbclient.bridge.json.Json;

/**
 * What the metadata calls cost.
 *
 * <h2>Why this is measured separately from the queries</h2>
 *
 * The query metrics say how long a statement took, which is the right answer to "why is this query
 * slow" - unless the time was not spent in the statement. Reading a table's columns, a table's comments or
 * a schema's table list goes through {@code DatabaseMetaData}, and on some drivers those are enormous
 * catalog queries: the statement itself runs in milliseconds while the introspection around it takes
 * minutes. Seen only through query timings, that looks like a slow database. Broken down by call, it names
 * the call.
 *
 * <h2>What is kept</h2>
 *
 * A running total per call - how often, how long in total, how many failed - and the slowest individual
 * calls with the object they were about. The totals answer "which of these is the problem at all"; the
 * individual ones answer "which table", which is the form the answer has to take before anything can be
 * done about it. Both are bounded, because this is fed for the life of the process.
 */
public final class MetadataMetrics {

    /** How many of the slowest individual calls are remembered. */
    private static final int SLOWEST_LIMIT = 20;

    /** How many per-call totals the payload reports. */
    private static final int CALL_LIMIT = 12;

    /** One call, for the slowest list. */
    private record Call(long millis, String call, String subject, String connectionId, boolean succeeded) {
    }

    /** Totals per call name, keyed by something like `columns`. */
    private static final class Totals {
        private long count;
        private long millis;
        private long failures;
    }

    private final Map<String, Totals> byCall = new ConcurrentHashMap<>();

    /** Guarded by itself: sorted on write, so reading it is free. */
    private final List<Call> slowest = new ArrayList<>();

    /**
     * Records one call.
     *
     * @param call       the metadata read, e.g. {@code columns}
     * @param subject    what it was about, e.g. {@code public.orders}; empty when there is nothing to name
     * @param millis     how long it took, wall clock, including the wait for a pooled connection
     * @param succeeded  false when the call threw, which is the case worth being able to tell apart from
     *                   a fast one
     */
    public void record(String connectionId, String call, String subject, long millis, boolean succeeded) {
        Totals totals = byCall.computeIfAbsent(call, name -> new Totals());
        synchronized (totals) {
            totals.count++;
            totals.millis += millis;
            if (!succeeded) {
                totals.failures++;
            }
        }

        Call entry = new Call(millis, call, subject == null ? "" : subject, connectionId, succeeded);
        synchronized (slowest) {
            if (slowest.size() < SLOWEST_LIMIT) {
                slowest.add(entry);
                slowest.sort(Comparator.comparingLong(Call::millis).reversed());
                return;
            }
            // Full: the shortest of the remembered calls is the only one worth replacing, and comparing
            // against it first keeps the common case - a fast call - out of the list entirely.
            Call last = slowest.get(slowest.size() - 1);
            if (entry.millis() <= last.millis()) {
                return;
            }
            slowest.remove(slowest.size() - 1);
            slowest.add(entry);
            slowest.sort(Comparator.comparingLong(Call::millis).reversed());
        }
    }

    /** The totals and the slowest calls, ready to be put into a health snapshot. */
    public Map<String, Object> payload() {
        List<Map.Entry<String, Totals>> totals = new ArrayList<>(byCall.entrySet());
        // Sorted by total time rather than by count: a call made twice for forty seconds is the reason
        // somebody opened this report, and one made a hundred times in four milliseconds is not.
        totals.sort(Comparator.comparingLong((Map.Entry<String, Totals> entry) -> entry.getValue().millis).reversed());

        List<Object> calls = new ArrayList<>();
        for (Map.Entry<String, Totals> entry : totals) {
            if (calls.size() >= CALL_LIMIT) {
                break;
            }
            Totals value = entry.getValue();
            calls.add(Json.obj(
                    "call", entry.getKey(),
                    "count", value.count,
                    "millis", value.millis,
                    "averageMillis", value.count == 0 ? 0L : value.millis / value.count,
                    "failures", value.failures));
        }

        List<Object> recent = new ArrayList<>();
        synchronized (slowest) {
            for (Call entry : slowest) {
                recent.add(Json.obj(
                        "call", entry.call(),
                        "subject", entry.subject(),
                        "connectionId", entry.connectionId(),
                        "millis", entry.millis(),
                        "succeeded", entry.succeeded()));
            }
        }

        return Json.obj("calls", calls, "slowest", recent);
    }
}
