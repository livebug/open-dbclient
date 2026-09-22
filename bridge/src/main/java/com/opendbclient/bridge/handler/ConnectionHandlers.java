package com.opendbclient.bridge.handler;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.opendbclient.bridge.BridgeServices;
import com.opendbclient.bridge.conn.ConnectionProfileSpec;
import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.rpc.Protocol;
import com.opendbclient.bridge.rpc.RpcServer;

/**
 * Connection lifecycle: open, test, close and enumerate.
 *
 * <p>Errors are not caught here. {@link com.opendbclient.bridge.rpc.RpcException} conversion
 * happens centrally in the dispatcher, which preserves SQLState and vendor error codes, so a
 * failed login reaches the user with the database's own explanation intact.
 */
public final class ConnectionHandlers {

    /**
     * Placeholder identifier used when testing an unsaved profile.
     *
     * A test opens a throwaway connection that is never registered in the pool registry, but the
     * profile record still needs an identifier to satisfy its own invariants.
     */
    private static final String TEST_CONNECTION_ID = "<connection-test>";

    private ConnectionHandlers() {
    }

    public static void register(RpcServer server, BridgeServices services) {
        server.register(Protocol.CONNECTION_OPEN, (params, ctx) -> {
            ConnectionProfileSpec spec = ConnectionProfileSpec.from(params);
            return services.connections().open(spec).toPayload();
        });

        server.register(Protocol.CONNECTION_TEST, (params, ctx) -> {
            // The editor tests the form as typed, so no identifier exists yet.
            Map<String, Object> withId = new LinkedHashMap<>(params);
            withId.putIfAbsent("connectionId", TEST_CONNECTION_ID);
            ConnectionProfileSpec spec = ConnectionProfileSpec.from(withId);
            return services.connections().test(spec).toPayload();
        });

        server.register(Protocol.CONNECTION_CLOSE, (params, ctx) -> {
            String connectionId = Json.requireStr(params, "connectionId");

            // Cancel anything still running first: it needs the connection to exist so the driver
            // can abort the statement, and releasing results first would orphan an active query.
            List<String> cancelledQueries = services.queries().cancelForConnection(connectionId);
            List<String> releasedResults = services.queries().releaseForConnection(connectionId);
            boolean closed = services.connections().close(connectionId);

            Map<String, Object> payload = Json.obj("connectionId", connectionId, "closed", closed);
            if (!cancelledQueries.isEmpty()) {
                payload.put("cancelledQueries", new ArrayList<Object>(cancelledQueries));
            }
            if (!releasedResults.isEmpty()) {
                payload.put("releasedResults", new ArrayList<Object>(releasedResults));
            }
            return payload;
        });

        server.register(Protocol.CONNECTION_LIST, (params, ctx) -> Json.obj(
                "connections", new ArrayList<Object>(services.connections().list()),
                "count", services.connections().openCount()));
    }
}
