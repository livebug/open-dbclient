package com.opendbclient.bridge.handler;

import java.util.Map;

import com.opendbclient.bridge.BuildInfo;
import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.rpc.Protocol;
import com.opendbclient.bridge.rpc.RequestContext;
import com.opendbclient.bridge.rpc.RpcServer;

/**
 * Lifecycle and introspection handlers.
 *
 * <p>Extracted from {@code BridgeMain} so tests exercise the same registrations the
 * production process uses, rather than a parallel copy that can drift.
 */
public final class SystemHandlers {

    private SystemHandlers() {
    }

    public static void register(RpcServer server) {
        server.register(Protocol.SYSTEM_PING, (params, ctx) -> Json.obj(
                "pong", Boolean.TRUE,
                "version", BuildInfo.VERSION,
                "timestamp", System.currentTimeMillis()));

        server.register(Protocol.SYSTEM_INFO, (params, ctx) -> runtimeInfo(server));

        server.register(Protocol.SYSTEM_SHUTDOWN, (params, ctx) -> {
            Log.info("shutdown requested by extension host");
            return acknowledgeShutdown(ctx);
        });
    }

    /** Snapshot of the bridge process: JVM, heap, and server counters. */
    public static Map<String, Object> runtimeInfo(RpcServer server) {
        Runtime runtime = Runtime.getRuntime();
        return Json.obj(
                "version", BuildInfo.VERSION,
                "pid", ProcessHandle.current().pid(),
                "javaVersion", System.getProperty("java.version"),
                "javaVendor", System.getProperty("java.vendor"),
                "javaHome", System.getProperty("java.home"),
                "osName", System.getProperty("os.name"),
                "osArch", System.getProperty("os.arch"),
                "defaultEncoding", System.getProperty("file.encoding"),
                "maxHeapBytes", runtime.maxMemory(),
                "totalHeapBytes", runtime.totalMemory(),
                "freeHeapBytes", runtime.freeMemory(),
                "uptimeMillis", server.uptimeMillis(),
                "handlers", server.handlerCount(),
                "requestsHandled", server.requestsHandled(),
                "requestFailures", server.requestFailures(),
                "activeRequests", server.activeRequestCount());
    }

    /**
     * Acknowledges a shutdown request.
     *
     * <p>The actual stop is deferred until after this response is written - see
     * {@link RequestContext#requestShutdown()}. Closing the channel here would race the
     * response and the extension would never learn that its request was accepted.
     */
    public static Map<String, Object> acknowledgeShutdown(RequestContext ctx) {
        ctx.requestShutdown();
        return Json.obj("stopping", Boolean.TRUE);
    }
}
