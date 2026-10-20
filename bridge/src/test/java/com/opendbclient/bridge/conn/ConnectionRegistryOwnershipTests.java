package com.opendbclient.bridge.conn;

import com.opendbclient.bridge.Assert;
import com.opendbclient.bridge.TestRunner;
import com.opendbclient.bridge.pool.ConnectionPool;
import com.opendbclient.bridge.rpc.Protocol;
import com.opendbclient.bridge.rpc.RpcException;

/**
 * Tests for connection ownership.
 *
 * <p>On a shared {@code --listen} server many clients are in one process, so a connection opened by
 * one tenant must not be reachable by another. The ownership check lives in {@code requireEntry} and
 * {@code close}, and these tests exercise it through the {@code registerEntry} seam without opening
 * a real driver.
 */
public final class ConnectionRegistryOwnershipTests {

    private ConnectionRegistryOwnershipTests() {
    }

    public static void register(TestRunner runner) {
        runner.test("a tenant can use its own connection", ConnectionRegistryOwnershipTests::ownConnectionAllowed);
        runner.test("a tenant cannot use another tenant's connection", ConnectionRegistryOwnershipTests::otherTenantForbidden);
        runner.test("a tenant cannot close another tenant's connection", ConnectionRegistryOwnershipTests::otherTenantCannotClose);
        runner.test("an anonymous connection is only reachable anonymously", ConnectionRegistryOwnershipTests::anonymousConnection);
    }

    private static void ownConnectionAllowed() {
        ConnectionRegistry registry = registryWith("c", "A");
        Assert.notNull(registry.require("c", "A"), "the owning tenant may use the connection");
    }

    private static void otherTenantForbidden() {
        ConnectionRegistry registry = registryWith("c", "A");
        Assert.equal(Protocol.ERROR_FORBIDDEN,
                codeOf(() -> registry.require("c", "B")),
                "another tenant is refused");
    }

    private static void otherTenantCannotClose() {
        ConnectionRegistry registry = registryWith("c", "A");
        Assert.equal(Protocol.ERROR_FORBIDDEN,
                codeOf(() -> registry.close("c", "B")),
                "closing another tenant's connection is refused");
        Assert.that(registry.isOpen("c"), "the connection survives a refused close");
        Assert.that(registry.close("c", "A"), "the owning tenant may close it");
        Assert.that(!registry.isOpen("c"), "the connection is now closed");
    }

    private static void anonymousConnection() {
        ConnectionRegistry registry = registryWith("c", null);
        Assert.notNull(registry.require("c", null), "an anonymous tenant may use an anonymous connection");
        Assert.equal(Protocol.ERROR_FORBIDDEN,
                codeOf(() -> registry.require("c", "A")),
                "a named tenant cannot use an anonymous connection");
    }

    private static ConnectionRegistry registryWith(String connectionId, String ownerTenantId) {
        ConnectionRegistry registry = new ConnectionRegistry(new DriverLoader());
        registry.registerEntry(connectionId, pool(), DatabaseCapabilities.unknown(), ownerTenantId);
        return registry;
    }

    private static ConnectionPool pool() {
        // The factory is never called: these tests exercise ownership, not borrowing.
        return new ConnectionPool("c", () -> null, 1, 1, 0L, 0L);
    }

    private static String codeOf(Runnable action) {
        try {
            action.run();
            return null;
        } catch (RpcException failure) {
            return failure.code();
        }
    }
}
