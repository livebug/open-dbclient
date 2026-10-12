package com.opendbclient.bridge.conn;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.pool.ConnectionPool;
import com.opendbclient.bridge.rpc.Protocol;
import com.opendbclient.bridge.rpc.RpcException;

/**
 * Owns the active transactions, keyed by the connection they pin.
 *
 * <p>A transaction is one physical connection borrowed from a pool and kept checked out with
 * {@code autoCommit=false}. Every statement on that connection runs inside the transaction until
 * commit or rollback returns the connection to the pool. At most one transaction exists per
 * connection.
 *
 * <p>This class is deliberately ignorant of drivers and capability detection: the caller supplies
 * the pool and whether transactions are supported, which is what makes the state machine testable
 * against a fake {@link Connection}.
 */
public final class TransactionRegistry {

    /** How long {@code begin} waits for a pooled connection. */
    private static final long BORROW_TIMEOUT_MILLIS = 30_000L;

    private final Map<String, Transaction> transactions = new ConcurrentHashMap<>();

    /**
     * Guards the lifecycle transitions that mutate {@link #transactions}.
     *
     * <p>Statement execution does not take this lock: in-flight statements are serialised per
     * transaction by {@link Transaction#lock} instead, so the hot path never contends here.
     */
    private final Object lifecycle = new Object();

    /**
     * Starts a transaction on {@code connectionId}, pinning one physical connection with
     * {@code autoCommit=false}.
     *
     * <p>{@code timeoutMillis} of zero means the transaction never times out on its own. A
     * positive value is checked lazily: the first statement, commit, rollback or status read that
     * happens after the deadline rolls the transaction back automatically. The timeout mechanism
     * lives here so callers can enforce their own policy, but the kernel itself imposes none.
     *
     * @throws RpcException {@code TRANSACTION_ACTIVE} when the connection already has one
     * @throws RpcException {@code UNSUPPORTED} when {@code transactionsSupported} is false
     */
    public Map<String, Object> begin(
            String connectionId,
            ConnectionPool pool,
            boolean transactionsSupported,
            long timeoutMillis) throws SQLException {

        synchronized (lifecycle) {
            if (transactions.containsKey(connectionId)) {
                throw new RpcException(Protocol.ERROR_TRANSACTION_ACTIVE,
                        "connection '" + connectionId + "' already has an active transaction");
            }
            if (!transactionsSupported) {
                throw new RpcException(Protocol.ERROR_UNSUPPORTED,
                        "the driver for connection '" + connectionId + "' does not support transactions");
            }
            Connection connection = pool.borrow(BORROW_TIMEOUT_MILLIS);
            boolean previousAutoCommit;
            try {
                previousAutoCommit = connection.getAutoCommit();
                connection.setAutoCommit(false);
            } catch (SQLException | RuntimeException failure) {
                pool.release(connection);
                throw failure;
            }
            Transaction transaction = new Transaction(
                    connection, previousAutoCommit, System.nanoTime(), Math.max(0L, timeoutMillis));
            transactions.put(connectionId, transaction);
            return statusPayload(connectionId, transaction);
        }
    }

    /** Commits the active transaction and returns its connection to the pool. */
    public Map<String, Object> commit(String connectionId, ConnectionPool pool) throws SQLException {
        Transaction transaction = detach(connectionId, "commit");
        transaction.lock.lock();
        try {
            if (transaction.expired()) {
                rollbackAndRelease(connectionId, pool, transaction);
                throw new RpcException(Protocol.ERROR_TRANSACTION_TIMEOUT,
                        "transaction on '" + connectionId + "' expired and was rolled back");
            }
            commitAndRelease(connectionId, pool, transaction);
            return endPayload(connectionId, "committed");
        } finally {
            transaction.lock.unlock();
        }
    }

    /** Rolls back the active transaction and returns its connection to the pool. */
    public Map<String, Object> rollback(String connectionId, ConnectionPool pool) {
        Transaction transaction = detach(connectionId, "rollback");
        transaction.lock.lock();
        try {
            rollbackAndRelease(connectionId, pool, transaction);
            return endPayload(connectionId, "rolled_back");
        } finally {
            transaction.lock.unlock();
        }
    }

    /** Read-only view of the active transaction, without mutating it. */
    public Map<String, Object> status(String connectionId) {
        Transaction transaction = transactions.get(connectionId);
        if (transaction == null) {
            return Json.obj("connectionId", connectionId, "active", Boolean.FALSE);
        }
        return statusPayload(connectionId, transaction);
    }

    /**
     * Supplies the connection a statement should run on.
     *
     * <p>When {@code connectionId} has no active transaction this borrows a pooled connection and
     * {@link StatementConnection#close()} returns it. When a transaction is active the pinned
     * connection is used and {@code close()} releases only the transaction's per-statement lock,
     * leaving the connection checked out for the transaction's lifetime. An expired transaction is
     * rolled back transparently before the statement runs.
     */
    public StatementConnection acquire(String connectionId, ConnectionPool pool, long borrowTimeoutMillis)
            throws SQLException {
        while (true) {
            Transaction transaction = transactions.get(connectionId);
            if (transaction == null) {
                return StatementConnection.pooled(pool, pool.borrow(borrowTimeoutMillis));
            }
            transaction.lock.lock();
            if (transactions.get(connectionId) != transaction) {
                // The transaction ended while we waited for its per-statement lock; retry.
                transaction.lock.unlock();
                continue;
            }
            if (transaction.expired()) {
                transaction.lock.unlock();
                expire(connectionId, pool, transaction);
                continue;
            }
            return StatementConnection.transactional(transaction);
        }
    }

    /**
     * Rolls back and releases any active transaction on {@code connectionId}.
     *
     * <p>Called before the connection is closed, so a pinned connection is not silently dropped
     * mid-transaction.
     */
    public void endForClose(String connectionId, ConnectionPool pool) {
        Transaction transaction;
        synchronized (lifecycle) {
            transaction = transactions.remove(connectionId);
        }
        if (transaction == null) {
            return;
        }
        transaction.lock.lock();
        try {
            rollbackAndRelease(connectionId, pool, transaction);
            Log.info("rolled back active transaction on '%s' before closing", connectionId);
        } finally {
            transaction.lock.unlock();
        }
    }

    /** Rolls back an expired transaction and returns its connection, if it is still the active one. */
    private void expire(String connectionId, ConnectionPool pool, Transaction transaction) {
        synchronized (lifecycle) {
            if (!transactions.remove(connectionId, transaction)) {
                return; // ended concurrently
            }
        }
        transaction.lock.lock();
        try {
            rollbackAndRelease(connectionId, pool, transaction);
        } finally {
            transaction.lock.unlock();
        }
        Log.info("transaction on '%s' expired and was rolled back", connectionId);
    }

    /** Removes the active transaction, throwing when there is none. */
    private Transaction detach(String connectionId, String action) {
        synchronized (lifecycle) {
            Transaction transaction = transactions.remove(connectionId);
            if (transaction == null) {
                throw new RpcException(Protocol.ERROR_TRANSACTION_NOT_FOUND,
                        "no active transaction on '" + connectionId + "' to " + action);
            }
            return transaction;
        }
    }

    private void commitAndRelease(String connectionId, ConnectionPool pool, Transaction transaction)
            throws SQLException {
        try {
            transaction.connection.commit();
        } catch (SQLException | RuntimeException failure) {
            restoreAutoCommit(transaction);
            pool.release(transaction.connection);
            Log.warn("commit on '%s' failed; rolled back: %s", connectionId, failure.getMessage());
            throw failure;
        }
        restoreAutoCommit(transaction);
        pool.release(transaction.connection);
    }

    private void rollbackAndRelease(String connectionId, ConnectionPool pool, Transaction transaction) {
        try {
            transaction.connection.rollback();
        } catch (SQLException failure) {
            Log.debug("rollback on '%s' failed: %s", connectionId, failure.getMessage());
        }
        restoreAutoCommit(transaction);
        pool.release(transaction.connection);
    }

    private static void restoreAutoCommit(Transaction transaction) {
        try {
            transaction.connection.setAutoCommit(transaction.previousAutoCommit);
        } catch (SQLException failure) {
            Log.debug("restoring autoCommit failed: %s", failure.getMessage());
        }
    }

    private static Map<String, Object> statusPayload(String connectionId, Transaction transaction) {
        long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - transaction.startedNanos);
        Map<String, Object> payload = Json.obj(
                "connectionId", connectionId,
                "active", Boolean.TRUE,
                "elapsedMillis", elapsedMillis);
        if (transaction.timeoutMillis > 0) {
            payload.put("timeoutMillis", transaction.timeoutMillis);
            payload.put("expired", transaction.expired());
        }
        return payload;
    }

    private static Map<String, Object> endPayload(String connectionId, String status) {
        return Json.obj("connectionId", connectionId, "active", Boolean.FALSE, "status", status);
    }

    /**
     * A single active transaction: one physical connection pinned with {@code autoCommit=false},
     * plus the bookkeeping needed to restore it and to roll it back on timeout.
     */
    private static final class Transaction {

        final Connection connection;
        final boolean previousAutoCommit;
        final long startedNanos;
        final long timeoutMillis; // zero means no timeout
        final ReentrantLock lock = new ReentrantLock();

        Transaction(Connection connection, boolean previousAutoCommit, long startedNanos, long timeoutMillis) {
            this.connection = connection;
            this.previousAutoCommit = previousAutoCommit;
            this.startedNanos = startedNanos;
            this.timeoutMillis = timeoutMillis;
        }

        boolean expired() {
            return timeoutMillis > 0
                    && TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos) >= timeoutMillis;
        }
    }

    /**
     * A connection handed to a statement, together with how to give it back.
     *
     * <p>Pooled statements return the connection to the pool; transactional statements release
     * only the transaction's per-statement lock, leaving the connection pinned for the
     * transaction's lifetime.
     */
    public static final class StatementConnection implements AutoCloseable {

        private final Connection connection;
        private final ConnectionPool pool;
        private final Transaction transaction;

        private StatementConnection(Connection connection, ConnectionPool pool, Transaction transaction) {
            this.connection = connection;
            this.pool = pool;
            this.transaction = transaction;
        }

        static StatementConnection pooled(ConnectionPool pool, Connection connection) {
            return new StatementConnection(connection, pool, null);
        }

        static StatementConnection transactional(Transaction transaction) {
            return new StatementConnection(transaction.connection, null, transaction);
        }

        public Connection connection() {
            return connection;
        }

        @Override
        public void close() {
            if (transaction != null) {
                transaction.lock.unlock();
            } else {
                pool.release(connection);
            }
        }
    }
}
