package com.opendbclient.bridge.health;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryUsage;
import java.lang.management.RuntimeMXBean;
import java.lang.management.ThreadMXBean;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import com.opendbclient.bridge.conn.ConnectionRegistry;
import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.result.QueryRegistry;
import com.opendbclient.bridge.rpc.EventSink;
import com.opendbclient.bridge.rpc.Protocol;
import com.opendbclient.bridge.rpc.RpcServer;

/**
 * Collects operational metrics for the bridge process and pushes them on request.
 *
 * <h2>What is measured, and what is not</h2>
 *
 * Everything here describes the JDBC layer and the bridge itself: JVM memory, garbage collection,
 * threads, connection pool occupancy, spilled result sets and query timings. Deliberately absent are
 * database-side figures such as buffer pool hit ratios. Those live behind vendor-specific SQL -
 * {@code SHOW STATUS} on MySQL, {@code pg_stat_activity} on PostgreSQL - and reaching them would mean
 * writing exactly the dialect code this project exists without. The consequence is that "cache" in
 * these metrics always means the bridge's result cache, never the database's.
 *
 * <h2>Why the bridge pushes rather than the extension polling</h2>
 *
 * A subscription is one request and then a stream, so the interval is enforced by the side that
 * knows when a measurement was taken. Polling would also mean the extension pays a round trip per
 * sample, and would keep sampling even when nothing is watching.
 *
 * Collection uses {@link ManagementFactory} only, which keeps the bridge dependency-free.
 */
public final class HealthService implements AutoCloseable {

    /** Lower bound on the push interval, to keep a misconfigured client from flooding the channel. */
    private static final long MIN_INTERVAL_MILLIS = 500L;

    /** Upper bound, generous enough to be a deliberate choice rather than a mistake. */
    private static final long MAX_INTERVAL_MILLIS = 300_000L;

    private final ConnectionRegistry connections;
    private final QueryRegistry queries;
    private final RpcServer server;

    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(
            runnable -> {
                Thread thread = new Thread(runnable, "health-push");
                thread.setDaemon(true);
                return thread;
            });

    private final AtomicInteger failureStreak = new AtomicInteger();

    private volatile ScheduledFuture<?> pushTask;
    private volatile EventSink sink;
    private volatile long intervalMillis;

    public HealthService(ConnectionRegistry connections, QueryRegistry queries, RpcServer server) {
        this.connections = connections;
        this.queries = queries;
        this.server = server;
    }

    /** Current metrics, collected synchronously. */
    public Map<String, Object> snapshot() {
        return Json.obj(
                "timestamp", System.currentTimeMillis(),
                "uptimeMillis", uptimeMillis(),
                "memory", memory(),
                "garbageCollector", garbageCollector(),
                "threads", threads(),
                "server", serverMetrics(),
                "connections", new ArrayList<Object>(connections.list()),
                "connectionCount", connections.openCount(),
                "poolSummaries", poolSummaries(),
                "cache", cache(),
                "queries", queries.metricsPayload());
    }

    /**
     * Starts pushing metrics.
     *
     * <p>Calling this again replaces the previous subscription rather than adding a second one, and
     * a zero or negative interval stops it. Without that, a client that subscribed twice would
     * receive every sample twice and the duplicate would be invisible in the UI.
     */
    public void subscribe(EventSink sink, long requestedIntervalMillis) {
        unsubscribe();
        if (requestedIntervalMillis <= 0) {
            return;
        }

        long interval = Math.min(MAX_INTERVAL_MILLIS, Math.max(MIN_INTERVAL_MILLIS, requestedIntervalMillis));
        this.sink = sink;
        this.intervalMillis = interval;
        this.failureStreak.set(0);

        this.pushTask = scheduler.scheduleWithFixedDelay(this::pushOnce, interval, interval, TimeUnit.MILLISECONDS);
        Log.debug("Health metrics will be pushed every %d ms", interval);
    }

    public void unsubscribe() {
        ScheduledFuture<?> task = this.pushTask;
        if (task != null) {
            task.cancel(false);
            this.pushTask = null;
            Log.debug("Health metrics subscription stopped");
        }
        this.sink = null;
        this.intervalMillis = 0L;
    }

    public boolean isSubscribed() {
        return pushTask != null;
    }

    public long intervalMillis() {
        return intervalMillis;
    }

    @Override
    public void close() {
        unsubscribe();
        scheduler.shutdownNow();
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    private void pushOnce() {
        EventSink target = this.sink;
        if (target == null) {
            return;
        }
        try {
            // A slightly smaller payload than a full snapshot: repeating the connection summaries on
            // every tick would dominate the channel without telling the user anything new.
            target.emit(Protocol.EVENT_HEALTH_METRICS, Json.obj(
                    "timestamp", System.currentTimeMillis(),
                    "uptimeMillis", uptimeMillis(),
                    "memory", memory(),
                    "garbageCollector", garbageCollector(),
                    "threads", threads(),
                    "server", serverMetrics(),
                    "poolSummaries", poolSummaries(),
                    "cache", cache(),
                    "queries", queries.metricsPayload()));
            failureStreak.set(0);
        } catch (RuntimeException failure) {
            // If the channel has gone away there is nobody left to push to, so stop rather than log
            // the same failure on every tick for the rest of the session.
            if (failureStreak.incrementAndGet() >= 3) {
                Log.debug("Stopping health pushes after repeated failures: %s", failure.getMessage());
                unsubscribe();
            }
        }
    }

    private long uptimeMillis() {
        return server.uptimeMillis();
    }

    private Map<String, Object> memory() {
        MemoryMXBean memoryBean = ManagementFactory.getMemoryMXBean();
        MemoryUsage heap = memoryBean.getHeapMemoryUsage();

        // maxMemory() is authoritative, whereas MemoryUsage.getMax() returns -1 on some JVMs.
        long heapMax = Runtime.getRuntime().maxMemory();
        long heapUsed = heap.getUsed();

        return Json.obj(
                "heapUsed", heapUsed,
                "heapCommitted", heap.getCommitted(),
                "heapMax", heapMax,
                "heapUsedPercent", percentage(heapUsed, heapMax),
                "nonHeapUsed", memoryBean.getNonHeapMemoryUsage().getUsed(),
                "nonHeapCommitted", memoryBean.getNonHeapMemoryUsage().getCommitted(),
                "metaspaceUsed", poolUsed("Metaspace"),
                "pools", poolBreakdown());
    }

    private long poolUsed(String name) {
        try {
            for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
                if (name.equalsIgnoreCase(pool.getName())) {
                    MemoryUsage usage = pool.getUsage();
                    return usage == null ? 0L : usage.getUsed();
                }
            }
        } catch (RuntimeException failure) {
            Log.debug("Could not read memory pool '%s': %s", name, failure.getMessage());
        }
        return 0L;
    }

    private List<Object> poolBreakdown() {
        List<Object> pools = new ArrayList<>();
        try {
            for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
                MemoryUsage usage = pool.getUsage();
                if (usage == null) {
                    continue;
                }
                pools.add(Json.obj(
                        "name", pool.getName(),
                        "type", pool.getType().name(),
                        "used", usage.getUsed(),
                        "committed", usage.getCommitted(),
                        "max", usage.getMax()));
            }
        } catch (RuntimeException failure) {
            Log.debug("Could not enumerate memory pools: %s", failure.getMessage());
        }
        return pools;
    }

    private Map<String, Object> garbageCollector() {
        long collections = 0;
        long collectionTime = 0;
        List<Object> collectors = new ArrayList<>();

        try {
            for (GarbageCollectorMXBean collector : ManagementFactory.getGarbageCollectorMXBeans()) {
                long count = Math.max(0L, collector.getCollectionCount());
                long time = Math.max(0L, collector.getCollectionTime());
                collections += count;
                collectionTime += time;
                collectors.add(Json.obj(
                        "name", collector.getName(),
                        "collections", count,
                        "collectionTimeMillis", time));
            }
        } catch (RuntimeException failure) {
            Log.debug("Could not read garbage collector statistics: %s", failure.getMessage());
        }

        long uptime = Math.max(1L, ManagementFactory.getRuntimeMXBean().getUptime());
        return Json.obj(
                "collections", collections,
                "collectionTimeMillis", collectionTime,
                // Share of wall-clock time spent collecting. A value that keeps climbing is the
                // clearest signal that the heap is too small for the queries being run.
                "collectionTimePercent", percentage(collectionTime, uptime),
                "collectors", collectors);
    }

    private Map<String, Object> threads() {
        try {
            ThreadMXBean threadBean = ManagementFactory.getThreadMXBean();
            return Json.obj(
                    "count", threadBean.getThreadCount(),
                    "peak", threadBean.getPeakThreadCount(),
                    "daemon", threadBean.getDaemonThreadCount());
        } catch (RuntimeException failure) {
            Log.debug("Could not read thread statistics: %s", failure.getMessage());
            return Json.obj("count", 0, "peak", 0, "daemon", 0);
        }
    }

    private Map<String, Object> serverMetrics() {
        return Json.obj(
                "requestsHandled", server.requestsHandled(),
                "requestFailures", server.requestFailures(),
                "activeRequests", server.activeRequestCount(),
                "handlers", server.handlerCount());
    }

    /** One compact entry per open connection, for the connection table on the dashboard. */
    private List<Object> poolSummaries() {
        List<Object> summaries = new ArrayList<>();
        connections.poolStats().forEach((stats) -> summaries.add(Json.obj(
                "connectionId", stats.profileId(),
                "maxSize", stats.maxSize(),
                "total", stats.total(),
                "active", stats.active(),
                "idle", stats.idle(),
                "waiting", stats.waiting(),
                "borrowed", stats.borrowed(),
                "borrowTimeouts", stats.borrowTimeouts(),
                "validationFailures", stats.validationFailures(),
                "connectFailures", stats.connectFailures(),
                "averageBorrowWaitMillis", stats.averageBorrowWaitMillis(),
                "utilisation", stats.utilisation(),
                "closed", stats.closed())));
        return summaries;
    }

    private Map<String, Object> cache() {
        List<Map<String, Object>> results = queries.resultsPayload();
        return Json.obj(
                "storedResults", results.size(),
                "cachedBytes", queries.usedCacheBytes(),
                "maxCacheBytes", queries.metricsPayload().get("maxCacheBytes"),
                "results", new ArrayList<Object>(results));
    }

    private static double percentage(long part, long whole) {
        if (whole <= 0) {
            return 0.0;
        }
        return Math.round((double) part / whole * 10_000.0) / 100.0;
    }
}
