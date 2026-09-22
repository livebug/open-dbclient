package com.opendbclient.bridge;

import com.opendbclient.bridge.conn.ConnectionRegistry;
import com.opendbclient.bridge.conn.DriverLoader;
import com.opendbclient.bridge.handler.ConnectionHandlers;
import com.opendbclient.bridge.handler.DriverHandlers;
import com.opendbclient.bridge.handler.ExportHandlers;
import com.opendbclient.bridge.handler.HealthHandlers;
import com.opendbclient.bridge.handler.MetadataHandlers;
import com.opendbclient.bridge.handler.QueryHandlers;
import com.opendbclient.bridge.handler.SystemHandlers;
import com.opendbclient.bridge.health.HealthService;
import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.result.QueryRegistry;
import com.opendbclient.bridge.rpc.RpcServer;

/**
 * Wires the bridge's subsystems together and registers their handlers.
 *
 * <p>One place names every subsystem, which keeps {@code BridgeMain} about stream plumbing and makes
 * the process-wide lifecycle explicit: everything created here is released in {@link #close()}.
 *
 * <p>The server is supplied at construction rather than at registration because
 * {@link HealthService} needs it to report its own request counters, and threading it in later would
 * mean working around the constructor and leaving a half-initialised object reachable.
 */
public final class BridgeServices implements AutoCloseable {

    private final RpcServer server;
    private final DriverLoader driverLoader = new DriverLoader();
    private final ConnectionRegistry connections = new ConnectionRegistry(driverLoader);
    private final QueryRegistry queries = new QueryRegistry();
    private final HealthService health;

    public BridgeServices(RpcServer server) {
        this.server = server;
        this.health = new HealthService(connections, queries, server);
    }

    /** Driver loading and the driver classpath. */
    public DriverLoader drivers() {
        return driverLoader;
    }

    /** Open connections and their pools. */
    public ConnectionRegistry connections() {
        return connections;
    }

    /** Running queries and their spilled results. */
    public QueryRegistry queries() {
        return queries;
    }

    /** Metrics collection and push scheduling. */
    public HealthService health() {
        return health;
    }

    /** Registers every RPC handler the bridge supports. */
    public void registerHandlers() {
        SystemHandlers.register(server);
        HealthHandlers.registerConfiguration(server, this);
        DriverHandlers.register(server, this);
        ConnectionHandlers.register(server, this);
        MetadataHandlers.register(server, this);
        QueryHandlers.register(server, this);
        ExportHandlers.register(server, this);
        HealthHandlers.register(server, this);
    }

    /**
     * Releases every resource the bridge owns.
     *
     * Order matters. Running queries are cancelled first, while their connections are still open and
     * {@code Statement.cancel()} can still reach the database. Spilled results go next, so temporary
     * files do not outlive the process. Connections are closed last, and only then are drivers
     * released - closing a connection runs driver code and needs those classes to still be reachable.
     */
    @Override
    public void close() {
        closeQuietly(health, "health monitoring");
        closeQuietly(queries, "the query registry");
        closeQuietly(connections::closeAll, "open connections");
        driverLoader.shutdown();
    }

    private static void closeQuietly(AutoCloseable resource, String what) {
        try {
            resource.close();
        } catch (Exception failure) {
            Log.warn("Shutting down %s failed: %s", what, failure.getMessage());
        }
    }
}
