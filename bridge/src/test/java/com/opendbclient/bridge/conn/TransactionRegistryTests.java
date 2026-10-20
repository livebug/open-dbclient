package com.opendbclient.bridge.conn;

import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.opendbclient.bridge.Assert;
import com.opendbclient.bridge.TestRunner;
import com.opendbclient.bridge.pool.ConnectionPool;
import com.opendbclient.bridge.rpc.Protocol;
import com.opendbclient.bridge.rpc.RpcException;

/**
 * Tests for the transaction state machine.
 *
 * <p>The state machine is exercised against a {@link ConnectionPool} whose factory produces a
 * dynamic-proxy {@link Connection}. This keeps the tests free of any real driver while still
 * driving the pool's borrow/release/validation paths, which is where the subtle bugs live.
 */
public final class TransactionRegistryTests {

    private TransactionRegistryTests() {
    }

    public static void register(TestRunner runner) {
        runner.test("begin pins a connection with autoCommit off", TransactionRegistryTests::beginPinsConnection);
        runner.test("a second begin is rejected", TransactionRegistryTests::secondBeginRejected);
        runner.test("begin is rejected when unsupported", TransactionRegistryTests::unsupportedRejected);
        runner.test("commit restores autoCommit and releases", TransactionRegistryTests::commitRestores);
        runner.test("rollback restores autoCommit and releases", TransactionRegistryTests::rollbackRestores);
        runner.test("a statement runs on the pinned connection", TransactionRegistryTests::statementUsesPinnedConnection);
        runner.test("an expired transaction is rolled back", TransactionRegistryTests::expiredRolledBack);
        runner.test("commit with no transaction is rejected", TransactionRegistryTests::commitWithoutTransaction);
        runner.test("status reports an idle connection as inactive", TransactionRegistryTests::idleIsInactive);
        runner.test("closing rolls back an active transaction", TransactionRegistryTests::closeRollsBack);
    }

    // ------------------------------------------------------------------
    // cases
    // ------------------------------------------------------------------

    private static void beginPinsConnection() throws Exception {
        List<FakeConnection> created = new ArrayList<>();
        TransactionRegistry registry = new TransactionRegistry();
        ConnectionPool pool = pool(created);

        Map<String, Object> result = registry.begin("c", pool, true, 0L);

        Assert.equal(Boolean.TRUE, result.get("active"), "the transaction is active");
        Assert.equal(1, created.size(), "one connection was borrowed");
        Assert.equal(false, created.get(0).autoCommit, "autoCommit was switched off");
        Assert.equal(Boolean.TRUE, registry.status("c").get("active"), "status agrees");
    }

    private static void secondBeginRejected() throws Exception {
        List<FakeConnection> created = new ArrayList<>();
        TransactionRegistry registry = new TransactionRegistry();
        ConnectionPool pool = pool(created);
        registry.begin("c", pool, true, 0L);

        Assert.equal(Protocol.ERROR_TRANSACTION_ACTIVE,
                codeOf(() -> registry.begin("c", pool, true, 0L)),
                "a second begin is rejected");
        Assert.equal(1, created.size(), "no second connection was borrowed");
    }

    private static void unsupportedRejected() throws Exception {
        TransactionRegistry registry = new TransactionRegistry();
        ConnectionPool pool = pool(new ArrayList<>());

        Assert.equal(Protocol.ERROR_UNSUPPORTED,
                codeOf(() -> registry.begin("c", pool, false, 0L)),
                "a driver without transaction support is rejected");
    }

    private static void commitRestores() throws Exception {
        List<FakeConnection> created = new ArrayList<>();
        TransactionRegistry registry = new TransactionRegistry();
        ConnectionPool pool = pool(created);
        registry.begin("c", pool, true, 0L);
        FakeConnection pinned = created.get(0);

        Map<String, Object> result = registry.commit("c", pool);

        Assert.equal("committed", result.get("status"), "commit reports success");
        Assert.equal(1, pinned.commits, "commit reached the connection");
        Assert.equal(true, pinned.autoCommit, "autoCommit was restored");
        Assert.equal(Boolean.FALSE, registry.status("c").get("active"), "the transaction is over");
    }

    private static void rollbackRestores() throws Exception {
        List<FakeConnection> created = new ArrayList<>();
        TransactionRegistry registry = new TransactionRegistry();
        ConnectionPool pool = pool(created);
        registry.begin("c", pool, true, 0L);
        FakeConnection pinned = created.get(0);

        Map<String, Object> result = registry.rollback("c", pool);

        Assert.equal("rolled_back", result.get("status"), "rollback reports success");
        Assert.equal(1, pinned.rollbacks, "rollback reached the connection");
        Assert.equal(true, pinned.autoCommit, "autoCommit was restored");
        Assert.equal(Boolean.FALSE, registry.status("c").get("active"), "the transaction is over");
    }

    private static void statementUsesPinnedConnection() throws Exception {
        List<FakeConnection> created = new ArrayList<>();
        TransactionRegistry registry = new TransactionRegistry();
        ConnectionPool pool = pool(created);
        registry.begin("c", pool, true, 0L);
        FakeConnection pinned = created.get(0);

        try (TransactionRegistry.StatementConnection statement = registry.acquire("c", pool, 30_000L)) {
            Assert.that(statement.connection() == pinned.connection,
                    "the statement runs on the connection the transaction pinned");
        }
        Assert.equal(1, created.size(), "no second connection was borrowed during the transaction");
        Assert.equal(Boolean.TRUE, registry.status("c").get("active"), "the transaction survives a statement");
    }

    private static void expiredRolledBack() throws Exception {
        List<FakeConnection> created = new ArrayList<>();
        TransactionRegistry registry = new TransactionRegistry();
        ConnectionPool pool = pool(created);
        registry.begin("c", pool, true, 1L); // 1 ms timeout
        FakeConnection pinned = created.get(0);
        Thread.sleep(10);

        Assert.equal(Protocol.ERROR_TRANSACTION_TIMEOUT,
                codeOf(() -> registry.commit("c", pool)),
                "committing after the deadline is rejected");
        Assert.equal(1, pinned.rollbacks, "the expired transaction was rolled back");
        Assert.equal(true, pinned.autoCommit, "autoCommit was restored");
        Assert.equal(Boolean.FALSE, registry.status("c").get("active"), "the transaction is over");
    }

    private static void commitWithoutTransaction() throws Exception {
        TransactionRegistry registry = new TransactionRegistry();
        ConnectionPool pool = pool(new ArrayList<>());

        Assert.equal(Protocol.ERROR_TRANSACTION_NOT_FOUND,
                codeOf(() -> registry.commit("c", pool)),
                "committing without a transaction is rejected");
    }

    private static void idleIsInactive() {
        TransactionRegistry registry = new TransactionRegistry();
        Map<String, Object> status = registry.status("c");
        Assert.equal(Boolean.FALSE, status.get("active"), "no transaction means inactive");
    }

    private static void closeRollsBack() throws Exception {
        List<FakeConnection> created = new ArrayList<>();
        TransactionRegistry registry = new TransactionRegistry();
        ConnectionPool pool = pool(created);
        registry.begin("c", pool, true, 0L);
        FakeConnection pinned = created.get(0);

        registry.endForClose("c", pool);

        Assert.equal(1, pinned.rollbacks, "closing rolled the transaction back");
        Assert.equal(true, pinned.autoCommit, "autoCommit was restored");
        Assert.equal(Boolean.FALSE, registry.status("c").get("active"), "the transaction is over");
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private static ConnectionPool pool(List<FakeConnection> created) {
        return new ConnectionPool("c", () -> {
            FakeConnection fake = new FakeConnection();
            created.add(fake);
            return fake.connection;
        }, 1, 1, 0L, 0L);
    }

    /** Runs {@code body} and returns the {@link RpcException} code it threw, or {@code null}. */
    private static String codeOf(Throwing body) {
        try {
            body.run();
            return null;
        } catch (RpcException failure) {
            return failure.code();
        } catch (Exception failure) {
            throw new AssertionError("expected an RpcException but got " + failure, failure);
        }
    }

    @FunctionalInterface
    private interface Throwing {
        void run() throws Exception;
    }

    /** A {@link Connection} backed by a dynamic proxy, recording the calls the pool relies on. */
    private static final class FakeConnection {

        final Connection connection;
        boolean autoCommit = true;
        int commits;
        int rollbacks;
        int closes;

        FakeConnection() {
            connection = (Connection) Proxy.newProxyInstance(
                    Connection.class.getClassLoader(),
                    new Class<?>[] { Connection.class },
                    (proxy, method, args) -> switch (method.getName()) {
                        case "getAutoCommit" -> autoCommit;
                        case "setAutoCommit" -> {
                            autoCommit = (Boolean) args[0];
                            yield null;
                        }
                        case "commit" -> {
                            commits++;
                            yield null;
                        }
                        case "rollback" -> {
                            rollbacks++;
                            yield null;
                        }
                        case "close" -> {
                            closes++;
                            yield null;
                        }
                        case "isClosed" -> false;
                        case "isValid" -> true;
                        default -> throw new UnsupportedOperationException(method.getName());
                    });
        }
    }
}
