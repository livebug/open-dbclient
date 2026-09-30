package com.opendbclient.bridge.result;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The comments read so far, one entry per table.
 *
 * <h2>Why a cache and not just a call</h2>
 *
 * Reading a table's comments means calling {@code DatabaseMetaData.getColumns}. On the drivers this
 * project was written for that is not a cheap question: it is a large catalog query, and on a
 * PostgreSQL-compatible database behind a slow driver it can take seconds. Paying it once per distinct
 * table per query means the same table costs the same seconds every time somebody re-runs the same query
 * - which, in a tool where the query is edited and run again as a matter of course, is the entire cost.
 *
 * <h2>What is remembered</h2>
 *
 * Empty answers too. A table with no comments, or one a driver refuses to describe, is a fact worth
 * remembering for the same reason: otherwise the slow call happens again on the next query, in every
 * session, forever. The consequence - a comment added to the database later in the session does not appear
 * until the bridge restarts - is the trade this makes, and it is a comment.
 *
 * <h2>Bounded</h2>
 *
 * Least recently used, capped well above the number of tables a session touches, so a long-lived bridge
 * cannot grow without limit. Access order is used rather than insertion order because the tables somebody
 * keeps querying are the ones worth keeping.
 */
final class CommentCache {

    /** How many tables are remembered. A session would have to touch this many distinct tables to evict. */
    static final int DEFAULT_LIMIT = 512;

    private final int limit;

    /**
     * Guarded by itself.
     *
     * A plain {@code LinkedHashMap} in access order rather than a {@code synchronizedMap}: the read calls it
     * wraps can take seconds, and holding a lock for that long would turn one slow lookup into a stall for
     * every other lookup. Two threads racing on the same missing table do the same harmless work twice.
     */
    private final Map<String, Map<String, String>> entries;

    CommentCache(int limit) {
        this.limit = Math.max(1, limit);
        this.entries = new LinkedHashMap<>(64, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Map<String, String>> eldest) {
                return size() > CommentCache.this.limit;
            }
        };
    }

    /** The comments for a table, or null when they have not been read yet. */
    Map<String, String> get(String key) {
        synchronized (entries) {
            return entries.get(key);
        }
    }

    void put(String key, Map<String, String> comments) {
        synchronized (entries) {
            entries.put(key, comments);
        }
    }

    int size() {
        synchronized (entries) {
            return entries.size();
        }
    }
}
