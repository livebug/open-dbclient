package com.opendbclient.bridge.result;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.rpc.Protocol;
import com.opendbclient.bridge.rpc.RpcException;

/**
 * Owns running queries and their spilled results.
 *
 * <p>Responsibilities that would otherwise be scattered across handlers:
 *
 * - <b>Cancellation.</b> A running query must be reachable from another request, which is only
 *   possible because the server dispatches concurrently.
 * - <b>Disk budget.</b> Spilled results are bounded by a configurable byte limit, with the
 *   least-recently-used results evicted to stay inside it. Without this, running a handful of large
 *   queries would fill the user's temporary directory and nobody would notice until the disk filled.
 * - <b>Lifetime.</b> Results are closed when their connection closes or the bridge shuts down, so
 *   temporary files do not outlive the data they came from.
 */
public final class QueryRegistry implements AutoCloseable {

    /** Byte budget used until the extension reports the user's preference. */
    private static final long DEFAULT_MAX_CACHE_BYTES = 512L * 1024 * 1024;

    private final Map<String, ActiveQuery> running = new ConcurrentHashMap<>();
    private final Map<String, QueryResultStore> results = new ConcurrentHashMap<>();
    private final Map<String, String> ownerOfResult = new ConcurrentHashMap<>();
    private final AtomicLong querySequence = new AtomicLong();

    private final AtomicLong completed = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong cancelled = new AtomicLong();
    private final AtomicLong totalExecutionMillis = new AtomicLong();
    private final AtomicLong slowestExecutionMillis = new AtomicLong();
    private volatile String slowestQuerySummary;

    private volatile long maxCacheBytes = DEFAULT_MAX_CACHE_BYTES;

    /** Generates an identifier for a new query. */
    public String nextQueryId() {
        return "q" + querySequence.incrementAndGet();
    }

    // ------------------------------------------------------------------
    // running queries
    // ------------------------------------------------------------------

    public void beginRunning(ActiveQuery query) {
        running.put(query.queryId(), query);
    }

    public void endRunning(String queryId) {
        running.remove(queryId);
    }

    public ActiveQuery findRunning(String queryId) {
        return running.get(queryId);
    }

    public int runningCount() {
        return running.size();
    }

    /**
     * Cancels a running query.
     *
     * @throws RpcException with {@code QUERY_NOT_FOUND} when nothing by that id is still running,
     *                      which is the normal outcome of cancelling something that just finished
     */
    public void cancel(String queryId) {
        ActiveQuery query = running.get(queryId);
        if (query == null) {
            throw new RpcException(Protocol.ERROR_QUERY_NOT_FOUND,
                    "no query with id '" + queryId + "' is currently running");
        }
        if (query.cancel()) {
            cancelled.incrementAndGet();
            Log.info("Cancelling query '%s'", queryId);
        }
    }

    /** Cancels everything running against a connection, used when it is disconnected. */
    public List<String> cancelForConnection(String connectionId) {
        List<String> cancelledIds = new ArrayList<>();
        for (ActiveQuery query : running.values()) {
            if (query.connectionId().equals(connectionId) && query.cancel()) {
                cancelledIds.add(query.queryId());
            }
        }
        return cancelledIds;
    }

    // ------------------------------------------------------------------
    // stored results
    // ------------------------------------------------------------------

    /**
     * Publishes a completed result, evicting older ones if the budget is exceeded.
     */
    public void store(String queryId, String connectionId, QueryResultStore store) {
        results.put(queryId, store);
        ownerOfResult.put(queryId, connectionId);
        evictIfOverBudget(queryId);
    }

    public QueryResultStore require(String queryId) {
        QueryResultStore store = results.get(queryId);
        if (store == null) {
            throw new RpcException(Protocol.ERROR_QUERY_NOT_FOUND,
                    "the results of query '" + queryId + "' are no longer available. "
                            + "They are discarded when their connection closes or when the disk budget is reached.");
        }
        return store;
    }

    public void release(String queryId) {
        QueryResultStore store = results.remove(queryId);
        ownerOfResult.remove(queryId);
        if (store != null) {
            store.close();
        }
    }

    /** Releases every result belonging to a connection. */
    public List<String> releaseForConnection(String connectionId) {
        List<String> released = new ArrayList<>();
        for (Map.Entry<String, String> entry : ownerOfResult.entrySet()) {
            if (entry.getValue().equals(connectionId)) {
                released.add(entry.getKey());
            }
        }
        for (String queryId : released) {
            release(queryId);
        }
        return released;
    }

    /** Applies the configured disk budget, evicting immediately if it shrank. */
    public void setMaxCacheBytes(long bytes) {
        this.maxCacheBytes = Math.max(0, bytes);
        evictIfOverBudget(null);
    }

    public long usedCacheBytes() {
        long total = 0;
        for (QueryResultStore store : results.values()) {
            if (!store.isClosed()) {
                total += store.byteCount();
            }
        }
        return total;
    }

    // ------------------------------------------------------------------
    // metrics
    // ------------------------------------------------------------------

    public void recordCompletion(long elapsedMillis, String summary) {
        completed.incrementAndGet();
        totalExecutionMillis.addAndGet(elapsedMillis);
        if (elapsedMillis > slowestExecutionMillis.get()) {
            slowestExecutionMillis.set(elapsedMillis);
            slowestQuerySummary = summary;
        }
    }

    public void recordFailure() {
        failed.incrementAndGet();
    }

    /** Snapshot for the health panel. */
    public Map<String, Object> metricsPayload() {
        long finished = completed.get();
        Map<String, Object> payload = Json.obj(
                "running", running.size(),
                "completed", finished,
                "failed", failed.get(),
                "cancelled", cancelled.get(),
                "storedResults", results.size(),
                "cachedBytes", usedCacheBytes(),
                "maxCacheBytes", maxCacheBytes,
                "averageMillis", finished == 0 ? 0L : totalExecutionMillis.get() / finished,
                "slowestMillis", slowestExecutionMillis.get());
        if (slowestQuerySummary != null) {
            payload.put("slowestQuery", slowestQuerySummary);
        }
        return payload;
    }

    /** Per-result detail, for the cache section of the health panel. */
    public List<Map<String, Object>> resultsPayload() {
        List<Map<String, Object>> payloads = new ArrayList<>(results.size());
        long now = System.currentTimeMillis();
        for (QueryResultStore store : results.values()) {
            QueryResultStore.ResultMeta meta = store.meta();
            payloads.add(Json.obj(
                    "queryId", meta.queryId(),
                    "connectionId", ownerOfResult.getOrDefault(meta.queryId(), null),
                    "rows", meta.rowCount(),
                    "bytes", meta.byteCount(),
                    "columns", meta.columns().size(),
                    "ageMillis", now - meta.createdAtMillis(),
                    "idleMillis", now - meta.lastAccessedMillis()));
        }
        return payloads;
    }

    @Override
    public void close() {
        for (ActiveQuery query : running.values()) {
            query.cancel();
        }
        running.clear();

        for (String queryId : new ArrayList<>(results.keySet())) {
            release(queryId);
        }
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    /**
     * Brings the cache back inside its budget by discarding the least recently used results.
     *
     * @param justStored a query id that must never be evicted, so a result is not thrown away in the
     *                   same breath as being published
     */
    private void evictIfOverBudget(String justStored) {
        long total = usedCacheBytes();
        if (total <= maxCacheBytes) {
            return;
        }

        List<QueryResultStore> candidates = new ArrayList<>(results.values());
        candidates.removeIf((store) -> store.isClosed() || store.queryId().equals(justStored));
        // Oldest access first: the result nobody has looked at for longest is the safest to drop.
        candidates.sort(Comparator.comparingLong((store) -> store.meta().lastAccessedMillis()));

        for (QueryResultStore store : candidates) {
            if (total <= maxCacheBytes) {
                break;
            }
            long freed = store.byteCount();
            Log.debug("Evicting result '%s' (%d bytes) to stay within the cache budget", store.queryId(), freed);
            release(store.queryId());
            total -= freed;
        }

        if (total > maxCacheBytes) {
            Log.warn("Result cache is still %d bytes over its budget of %d", total - maxCacheBytes, maxCacheBytes);
        }
    }
}
