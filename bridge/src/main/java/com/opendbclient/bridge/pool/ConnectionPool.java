package com.opendbclient.bridge.pool;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import com.opendbclient.bridge.log.Log;

/**
 * A small connection pool written for this project rather than pulled in.
 *
 * <h2>Why not HikariCP</h2>
 *
 * Users supply their own driver jars, and JDBC drivers are notoriously shipped as fat jars
 * carrying stale copies of logging and utility libraries. Adding a pooling library to the bridge
 * would introduce a second set of transitive dependencies that could collide with whatever a
 * driver bundles. The bridge therefore has to stay dependency-free, which rules out an
 * off-the-shelf pool.
 *
 * <h2>What that costs, and why it is fine here</h2>
 *
 * HikariCP earns its complexity in servers that open thousands of short-lived connections per
 * second. An interactive database client does the opposite: a handful of long-lived connections,
 * idle most of the time. The default pool size of one reflects that, and behaves like a plain
 * long-lived connection until a user raises the limit to run queries concurrently.
 *
 * <h2>Invariant</h2>
 *
 * {@code total == idle.size() + checkedOut.size()} at all times. Every path that adjusts
 * {@code total} is paired with a corresponding change to one of those collections; breaking this
 * invariant would either exhaust the pool or over-allocate connections, and both failures are
 * silent until the pool is under load.
 */
public final class ConnectionPool implements AutoCloseable {

    /** Creates a physical connection. */
    @FunctionalInterface
    public interface ConnectionFactory {
        Connection create() throws SQLException;
    }

    private final String profileId;
    private final ConnectionFactory factory;
    private final int maxSize;
    private final long maxLifetimeMillis;
    private final long idleTimeoutMillis;
    private final int validationTimeoutSeconds;

    private final Object lock = new Object();
    private final Deque<Entry> idle = new ArrayDeque<>();

    /**
     * Checked-out connections, keyed by identity.
     *
     * <p>Identity rather than equality is required: a driver is free to implement
     * {@code equals} however it likes, and the pool must recognise the exact object instance it
     * handed out. Wrappers returned by drivers also make equality-based lookup unreliable.
     */
    private final Map<Connection, Entry> checkedOut = new IdentityHashMap<>();

    private int total;
    private int waiting;
    private boolean closed;

    private final AtomicLong created = new AtomicLong();
    private final AtomicLong destroyed = new AtomicLong();
    private final AtomicLong borrowed = new AtomicLong();
    private final AtomicLong borrowTimeouts = new AtomicLong();
    private final AtomicLong validationFailures = new AtomicLong();
    private final AtomicLong connectFailures = new AtomicLong();
    private final AtomicLong totalBorrowWaitNanos = new AtomicLong();
    private final AtomicLong maxBorrowWaitNanos = new AtomicLong();

    public ConnectionPool(
            String profileId,
            ConnectionFactory factory,
            int maxSize,
            int validationTimeoutSeconds,
            long maxLifetimeMillis,
            long idleTimeoutMillis) {
        this.profileId = profileId;
        this.factory = factory;
        this.maxSize = Math.max(1, maxSize);
        this.validationTimeoutSeconds = Math.max(1, validationTimeoutSeconds);
        this.maxLifetimeMillis = Math.max(0L, maxLifetimeMillis);
        this.idleTimeoutMillis = Math.max(0L, idleTimeoutMillis);
    }

    public String profileId() {
        return profileId;
    }

    /**
     * Obtains a connection, creating one if the pool has room.
     *
     * @param timeoutMillis how long to wait when the pool is at capacity
     * @throws SQLException when the pool is closed, creation fails, or the wait times out
     */
    public Connection borrow(long timeoutMillis) throws SQLException {
        long deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(Math.max(0L, timeoutMillis));
        long waitStartNanos = System.nanoTime();

        while (true) {
            Entry candidate = null;
            boolean reservedSlot = false;
            List<Connection> evicted = List.of();

            synchronized (lock) {
                if (closed) {
                    throw new SQLException("connection pool for '" + profileId + "' is closed");
                }
                evicted = collectEvictedLocked(System.currentTimeMillis());

                candidate = idle.pollFirst();
                if (candidate != null) {
                    // Move straight from idle to checked out so the invariant holds even if
                    // validation below throws.
                    checkedOut.put(candidate.connection, candidate);
                } else if (total < maxSize) {
                    // Reserve the slot now so concurrent borrows cannot both create a
                    // connection past the ceiling.
                    total++;
                    reservedSlot = true;
                }
            }

            // Closing a connection performs network I/O and can block, so it happens outside
            // the lock, after the pool's bookkeeping is already consistent.
            for (Connection stale : evicted) {
                destroyQuietly(stale, "evicted while idle");
            }

            if (candidate != null) {
                if (isUsable(candidate)) {
                    return activate(candidate, waitStartNanos);
                }
                // A connection that fails its liveness probe is our own housekeeping, not a
                // caller-visible error: drop it and try again without consuming the budget.
                synchronized (lock) {
                    checkedOut.remove(candidate.connection);
                    total--;
                    lock.notifyAll();
                }
                destroyQuietly(candidate.connection, "failed liveness probe");
                continue;
            }

            if (reservedSlot) {
                try {
                    Connection connection = factory.create();
                    created.incrementAndGet();
                    Entry entry = new Entry(connection, System.currentTimeMillis());
                    synchronized (lock) {
                        checkedOut.put(connection, entry);
                    }
                    return activate(entry, waitStartNanos);
                } catch (SQLException failure) {
                    connectFailures.incrementAndGet();
                    synchronized (lock) {
                        total--;
                        lock.notifyAll();
                    }
                    throw failure;
                } catch (RuntimeException failure) {
                    connectFailures.incrementAndGet();
                    synchronized (lock) {
                        total--;
                        lock.notifyAll();
                    }
                    throw failure;
                }
            }

            long remainingNanos = deadlineNanos - System.nanoTime();
            if (remainingNanos <= 0) {
                borrowTimeouts.incrementAndGet();
                throw new SQLException("timed out after " + timeoutMillis
                        + " ms waiting for a connection from pool '" + profileId
                        + "' (max pool size " + maxSize + ")", "08004");
            }

            awaitRelease(remainingNanos);
        }
    }

    /**
     * Returns a connection to the pool.
     *
     * <p>Connections that have exceeded their maximum lifetime, or that arrive after the pool
     * was closed, are destroyed instead of parked. Unknown connections are ignored rather than
     * closed, because the pool cannot know whether the caller still holds a reference.
     */
    public void release(Connection connection) {
        if (connection == null) {
            return;
        }

        Entry entry;
        boolean park;
        synchronized (lock) {
            entry = checkedOut.remove(connection);
            if (entry == null) {
                Log.debug("release called with a connection the pool does not own; ignoring");
                return;
            }
            long now = System.currentTimeMillis();
            park = !closed && !entry.expired(now, maxLifetimeMillis);
            if (park) {
                entry.lastUsedAtMillis = now;
                idle.addLast(entry);
            } else {
                total--;
            }
            lock.notifyAll();
        }

        if (!park) {
            destroyQuietly(connection, closed ? "pool closed" : "exceeded maximum lifetime");
        }
    }

    /**
     * Borrows a connection, runs {@code action}, and returns the connection.
     *
     * <p>Preferred over manual borrow/release: an exception in {@code action} still returns the
     * connection, so a failing query cannot leak a pooled connection.
     */
    public <T> T withConnection(long timeoutMillis, SqlAction<T> action) throws SQLException {
        Connection connection = borrow(timeoutMillis);
        try {
            return action.run(connection);
        } finally {
            release(connection);
        }
    }

    /** A unit of work that uses a borrowed connection. */
    @FunctionalInterface
    public interface SqlAction<T> {
        T run(Connection connection) throws SQLException;
    }

    /** Current state of the pool. */
    public PoolStats stats() {
        synchronized (lock) {
            return new PoolStats(
                    profileId,
                    maxSize,
                    total,
                    checkedOut.size(),
                    idle.size(),
                    waiting,
                    created.get(),
                    destroyed.get(),
                    borrowed.get(),
                    borrowTimeouts.get(),
                    validationFailures.get(),
                    connectFailures.get(),
                    TimeUnit.NANOSECONDS.toMillis(totalBorrowWaitNanos.get()),
                    TimeUnit.NANOSECONDS.toMillis(maxBorrowWaitNanos.get()),
                    closed);
        }
    }

    /** Closes idle connections and marks the pool unusable. */
    @Override
    public void close() {
        List<Connection> toDestroy = new ArrayList<>();
        int abandoned;
        synchronized (lock) {
            if (closed) {
                return;
            }
            closed = true;
            // Checked-out connections stay open: a query may still be streaming over one.
            // They are destroyed by release() once the caller is finished.
            abandoned = checkedOut.size();
            while (!idle.isEmpty()) {
                toDestroy.add(idle.pollFirst().connection);
                total--;
            }
            lock.notifyAll();
        }

        for (Connection connection : toDestroy) {
            destroyQuietly(connection, "pool closed");
        }
        if (abandoned > 0) {
            Log.debug("pool '%s' closed with %d connection(s) still checked out", profileId, abandoned);
        }
        Log.debug("pool '%s' closed, destroyed %d idle connection(s)", profileId, toDestroy.size());
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    private Connection activate(Entry entry, long waitStartNanos) {
        entry.lastUsedAtMillis = System.currentTimeMillis();
        borrowed.incrementAndGet();

        long waitedNanos = System.nanoTime() - waitStartNanos;
        totalBorrowWaitNanos.addAndGet(waitedNanos);
        maxBorrowWaitNanos.accumulateAndGet(waitedNanos, Math::max);

        return entry.connection;
    }

    private void awaitRelease(long remainingNanos) throws SQLException {
        long remainingMillis = Math.max(1L, TimeUnit.NANOSECONDS.toMillis(remainingNanos));
        synchronized (lock) {
            if (closed) {
                throw new SQLException("connection pool for '" + profileId + "' was closed while waiting");
            }
            waiting++;
            try {
                lock.wait(remainingMillis);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new SQLException("interrupted while waiting for a connection from pool '" + profileId + "'");
            } finally {
                waiting--;
            }
        }
    }

    /**
     * Probes whether a parked connection is still usable.
     *
     * <p>Falls back to {@code isClosed} when the driver predates {@code isValid}. Without that
     * fallback a perfectly good driver would have every connection rejected as invalid, and the
     * pool would churn connections forever carrying out no work.
     */
    private boolean isUsable(Entry entry) {
        try {
            return entry.connection.isValid(validationTimeoutSeconds);
        } catch (SQLFeatureNotSupportedException notSupported) {
            try {
                return !entry.connection.isClosed();
            } catch (SQLException failure) {
                validationFailures.incrementAndGet();
                Log.debug("isClosed failed during validation: %s", failure.getMessage());
                return false;
            }
        } catch (SQLException | RuntimeException failure) {
            validationFailures.incrementAndGet();
            Log.debug("connection failed validation: %s", failure.getMessage());
            return false;
        }
    }

    /**
     * Removes expired and over-idle parked connections, returning them for the caller to close
     * once it has released {@link #lock}.
     */
    private List<Connection> collectEvictedLocked(long now) {
        if (idle.isEmpty()) {
            return List.of();
        }
        List<Connection> evicted = null;
        var iterator = idle.iterator();
        while (iterator.hasNext()) {
            Entry entry = iterator.next();
            boolean tooOld = entry.expired(now, maxLifetimeMillis);
            boolean tooIdle = entry.idleTooLong(now, idleTimeoutMillis);
            if (tooOld || tooIdle) {
                iterator.remove();
                total--;
                if (evicted == null) {
                    evicted = new ArrayList<>(2);
                }
                evicted.add(entry.connection);
            }
        }
        return evicted == null ? List.of() : evicted;
    }

    private void destroyQuietly(Connection connection, String reason) {
        destroyed.incrementAndGet();
        try {
            connection.close();
            Log.trace("destroyed pooled connection (%s)", reason);
        } catch (SQLException | RuntimeException failure) {
            Log.debug("closing a pooled connection failed (%s): %s", reason, failure.getMessage());
        }
    }

    /** A pooled connection plus the bookkeeping the pool needs to age it out. */
    private static final class Entry {

        final Connection connection;
        final long createdAtMillis;
        long lastUsedAtMillis;

        Entry(Connection connection, long nowMillis) {
            this.connection = connection;
            this.createdAtMillis = nowMillis;
            this.lastUsedAtMillis = nowMillis;
        }

        boolean expired(long nowMillis, long maxLifetimeMillis) {
            return maxLifetimeMillis > 0 && nowMillis - createdAtMillis >= maxLifetimeMillis;
        }

        boolean idleTooLong(long nowMillis, long idleTimeoutMillis) {
            return idleTimeoutMillis > 0 && nowMillis - lastUsedAtMillis >= idleTimeoutMillis;
        }
    }
}
