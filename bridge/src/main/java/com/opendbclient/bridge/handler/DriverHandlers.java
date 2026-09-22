package com.opendbclient.bridge.handler;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.opendbclient.bridge.BridgeServices;
import com.opendbclient.bridge.conn.DriverInfo;
import com.opendbclient.bridge.conn.DriverRegistrationResult;
import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.rpc.Protocol;
import com.opendbclient.bridge.rpc.RpcServer;

/**
 * Driver discovery and classpath management.
 *
 * <p>The extension owns the driver folder; it scans the filesystem and reports the complete set
 * of jars on every {@code driver.register}. Keeping discovery on the extension side means the
 * bridge never needs to know where drivers live or how they are configured.
 */
public final class DriverHandlers {

    private DriverHandlers() {
    }

    public static void register(RpcServer server, BridgeServices services) {
        server.register(Protocol.DRIVER_LIST, (params, ctx) -> currentState(services));

        server.register(Protocol.DRIVER_REGISTER, (params, ctx) -> {
            List<Path> jarPaths = Json.stringList(params, "jarPaths").stream()
                    .map(Path::of)
                    .toList();
            List<String> driverClassNames = Json.stringList(params, "driverClassNames");

            DriverRegistrationResult result = services.drivers().register(jarPaths, driverClassNames);

            // A driver whose backing jar was replaced or removed leaves existing connections
            // holding classes from the previous class loader. Those connections cannot be
            // trusted, so they are dropped and the extension prompts for a reconnect.
            List<String> closedConnections = services.connections().closeForDrivers(result.staleDrivers());

            Map<String, Object> payload = result.toPayload();
            payload.put("closedConnections", new ArrayList<Object>(closedConnections));
            return payload;
        });

        server.register(Protocol.DRIVER_UNREGISTER, (params, ctx) -> Json.obj(
                "requiresRestart", Boolean.TRUE,
                "message", "A loaded class loader cannot be unloaded, so a removed driver only "
                        + "disappears after 'DB Client: Restart JDBC Bridge'."));
    }

    /** Current classpath and loaded drivers, without reloading anything. */
    private static Map<String, Object> currentState(BridgeServices services) {
        List<Object> driverPayloads = new ArrayList<>();
        for (DriverInfo driver : services.drivers().drivers()) {
            driverPayloads.add(driver.toPayload());
        }
        List<Object> jarPayloads = new ArrayList<>();
        for (Path jar : services.drivers().jarPaths()) {
            jarPayloads.add(jar.toString());
        }
        return Json.obj(
                "jarPaths", jarPayloads,
                "drivers", driverPayloads,
                "driverCount", driverPayloads.size());
    }
}
