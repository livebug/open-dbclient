package com.opendbclient.bridge.conn;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.Collection;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.pool.ConnectionPool;
import com.opendbclient.bridge.pool.PoolStats;
import com.opendbclient.bridge.rpc.Protocol;
import com.opendbclient.bridge.rpc.RpcException;

/**
 * Owns the open connections, keyed by the identifier the extension chose.
 *
 * <p>Each open profile gets one {@link ConnectionPool}. With the default pool size of one that
 * is simply a long-lived connection; raising the size allows concurrent queries without
 * changing any other code.
 */
public final class ConnectionRegistry {

    /**
     * Outcome of connecting or testing.
     *
     * @param connectionId  identifier used for subsequent requests
     * @param capabilities  what the database reported about itself
     * @param connectMillis how long establishing the connection took
     */
    public record ProbeResult(
            String connectionId,
            String driverClassName,
            DatabaseCapabilities capabilities,
            long connectMillis) {

        public Map<String, Object> toPayload() {
            return Json.obj(
                    "connectionId", connectionId,
                    "driverClassName", driverClassName,
                    "connectMillis", connectMillis,
                    "capabilities", capabilities.toPayload());
        }
    }

    /** Extra grace added to the borrow timeout during connect, on top of the login timeout. */
    private static final long CONNECT_GRACE_MILLIS = 5_000L;

    private final DriverLoader driverLoader;
    private final Map<String, Entry> entries = new ConcurrentHashMap<>();

    public ConnectionRegistry(DriverLoader driverLoader) {
        this.driverLoader = driverLoader;
    }

    /**
     * Opens a profile, reusing the existing pool when it targets the same database.
     *
     * <p>Capability detection piggybacks on the pool's first borrow rather than opening a
     * separate probe connection, so connecting costs one round trip instead of two.
     */
    public ProbeResult open(ConnectionProfileSpec spec) throws SQLException {
        Entry existing = entries.get(spec.connectionId());
        if (existing != null) {
            if (sameTarget(existing.spec, spec)) {
                existing.lastUsedMillis = System.currentTimeMillis();
                Log.debug("reusing open connection '%s'", spec.connectionId());
                return new ProbeResult(
                        spec.connectionId(), spec.driverClassName(), existing.capabilities, 0L);
            }
            Log.debug("connection '%s' targets a different database, reopening", spec.connectionId());
            close(spec.connectionId());
        }

        driverLoader.require(spec.driverClassName());

        ConnectionPool pool = new ConnectionPool(
                spec.connectionId(),
                () -> driverLoader.open(spec),
                spec.poolSize(),
                spec.validationTimeoutSeconds(),
                TimeUnit.SECONDS.toMillis(spec.maxLifetimeSeconds()),
                TimeUnit.SECONDS.toMillis(spec.idleTimeoutSeconds()));

        long startNanos = System.nanoTime();
        DatabaseCapabilities capabilities;
        try {
            long borrowTimeoutMillis = TimeUnit.SECONDS.toMillis(Math.max(1, spec.connectTimeoutSeconds()))
                    + CONNECT_GRACE_MILLIS;
            capabilities = pool.withConnection(borrowTimeoutMillis, DatabaseCapabilities::read);
        } catch (SQLException | RuntimeException failure) {
            // A pool whose first connection failed would otherwise linger holding a slot.
            pool.close();
            throw failure;
        }
        long connectMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos);

        entries.put(spec.connectionId(), new Entry(spec, pool, capabilities));
        Log.info("connected '%s': %s (%d ms)", spec.connectionId(), capabilities.describe(), connectMillis);
        return new ProbeResult(spec.connectionId(), spec.driverClassName(), capabilities, connectMillis);
    }

    /**
     * Opens a throwaway connection to validate the profile, then closes it.
     *
     * <p>Deliberately does not go through a pool: a test should leave no trace behind, and
     * registering a pool for a connection the user may immediately discard would be wrong.
     */
    public ProbeResult test(ConnectionProfileSpec spec) throws SQLException {
        driverLoader.require(spec.driverClassName());

        long startNanos = System.nanoTime();
        Connection connection = driverLoader.open(spec);
        try {
            DatabaseCapabilities capabilities = DatabaseCapabilities.read(connection);
            long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos);
            return new ProbeResult(spec.connectionId(), spec.driverClassName(), capabilities, elapsedMillis);
        } finally {
            try {
                connection.close();
            } catch (SQLException failure) {
                Log.debug("closing the test connection failed: %s", failure.getMessage());
            }
        }
    }

    /** Looks up an open connection, failing with a structured error when absent. */
    public ConnectionPool require(String connectionId) {
        Entry entry = entries.get(connectionId);
        if (entry == null) {
            throw new RpcException(Protocol.ERROR_CONNECTION_NOT_FOUND,
                    "no open connection with id '" + connectionId + "'"
                            + (entries.isEmpty() ? " (nothing is connected)" : " (open: " + entries.keySet() + ")"));
        }
        entry.lastUsedMillis = System.currentTimeMillis();
        return entry.pool;
    }

    /** Capabilities of an open connection. */
    public DatabaseCapabilities capabilities(String connectionId) {
        Entry entry = entries.get(connectionId);
        if (entry == null) {
            throw new RpcException(Protocol.ERROR_CONNECTION_NOT_FOUND,
                    "no open connection with id '" + connectionId + "'");
        }
        return entry.capabilities;
    }

    public boolean isOpen(String connectionId) {
        return entries.containsKey(connectionId);
    }

    /** Closes a connection and its pool. Returns {@code false} when it was not open. */
    public boolean close(String connectionId) {
        Entry entry = entries.remove(connectionId);
        if (entry == null) {
            return false;
        }
        entry.pool.close();
        Log.info("closed connection '%s'", connectionId);
        return true;
    }

    /**
     * Closes every connection backed by one of the given drivers.
     *
     * <p>Invoked when a driver jar is replaced or removed. Pooled connections hold classes from
     * the class loader that loaded them, so continuing to use them after their jar changed is
     * unsafe; forcing a reconnect is the only correct response.
     *
     * @return identifiers of the connections that were closed
     */
    public List<String> closeForDrivers(Collection<String> driverClassNames) {
        if (driverClassNames.isEmpty()) {
            return List.of();
        }
        Set<String> affected = Set.copyOf(driverClassNames);
        List<String> closedIds = new ArrayList<>();
        for (Map.Entry<String, Entry> candidate : entries.entrySet()) {
            if (affected.contains(candidate.getValue().spec.driverClassName())) {
                if (close(candidate.getKey())) {
                    closedIds.add(candidate.getKey());
                }
            }
        }
        return closedIds;
    }

    /** Summaries of everything currently connected, including live pool statistics. */
    public List<Map<String, Object>> list() {
        long now = System.currentTimeMillis();
        List<Map<String, Object>> result = new ArrayList<>(entries.size());
        for (Entry entry : entries.values()) {
            result.add(Json.obj(
                    "connectionId", entry.spec.connectionId(),
                    "driverClassName", entry.spec.driverClassName(),
                    "url", entry.spec.url(),
                    "user", entry.spec.user(),
                    "uptimeMillis", now - entry.createdAtMillis,
                    "idleMillis", now - entry.lastUsedMillis,
                    "capabilities", entry.capabilities.toPayload(),
                    "pool", entry.pool.stats().toPayload()));
        }
        return result;
    }

    /** Pool statistics for every open connection, for the health panel. */
    public List<PoolStats> poolStats() {
        List<PoolStats> result = new ArrayList<>(entries.size());
        for (Entry entry : entries.values()) {
            result.add(entry.pool.stats());
        }
        return result;
    }

    public int openCount() {
        return entries.size();
    }

    /** Closes every connection. Called during bridge shutdown. */
    public void closeAll() {
        for (String connectionId : List.copyOf(entries.keySet())) {
            close(connectionId);
        }
    }

    /**
     * Decides whether a reopened profile points at the same database as an existing one.
     *
     * Any difference in credentials or driver properties counts as a different target: reusing a
     * pool that was opened with the previous password would silently keep working against an
     * account the user just changed.
     */
    private static boolean sameTarget(ConnectionProfileSpec a, ConnectionProfileSpec b) {
        return a.driverClassName().equals(b.driverClassName())
                && a.url().equals(b.url())
                && Objects.equals(a.user(), b.user())
                && Objects.equals(a.password(), b.password())
                && a.properties().equals(b.properties());
    }

    private static final class Entry {

        final ConnectionProfileSpec spec;
        final ConnectionPool pool;
        final DatabaseCapabilities capabilities;
        final long createdAtMillis;
        volatile long lastUsedMillis;

        Entry(ConnectionProfileSpec spec, ConnectionPool pool, DatabaseCapabilities capabilities) {
            this.spec = spec;
            this.pool = pool;
            this.capabilities = capabilities;
            this.createdAtMillis = System.currentTimeMillis();
            this.lastUsedMillis = this.createdAtMillis;
        }
    }
}
