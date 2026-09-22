package com.opendbclient.bridge.handler;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.opendbclient.bridge.BridgeServices;
import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.rpc.Protocol;
import com.opendbclient.bridge.rpc.RpcException;
import com.opendbclient.bridge.rpc.RpcServer;

/** Health metrics access: on-demand snapshots and periodic pushes. */
public final class HealthHandlers {

    private HealthHandlers() {
    }

    public static void register(RpcServer server, BridgeServices services) {
        server.register(Protocol.HEALTH_SNAPSHOT, (params, ctx) -> services.health().snapshot());

        server.register(Protocol.HEALTH_SUBSCRIBE, (params, ctx) -> {
            long intervalMillis = Json.longValue(params, "intervalMillis", 2_000L);
            services.health().subscribe(ctx.events(), intervalMillis);
            return Json.obj(
                    "subscribed", services.health().isSubscribed(),
                    "intervalMillis", services.health().intervalMillis());
        });

        server.register(Protocol.HEALTH_UNSUBSCRIBE, (params, ctx) -> {
            services.health().unsubscribe();
            return Json.obj("subscribed", Boolean.FALSE);
        });
    }

    /**
     * Applies process-wide settings that arrive from the extension.
     *
     * Currently just the result cache budget. It is a separate method rather than a parameter of
     * some unrelated call so that the setting takes effect whether or not health monitoring happens
     * to be enabled, which is exactly the class of bug that coupling them would create.
     */
    public static void registerConfiguration(RpcServer server, BridgeServices services) {
        server.register(Protocol.SYSTEM_CONFIGURE, (params, ctx) -> {
            Object maxCacheBytes = Json.get(params, "resultMaxCacheBytes");
            if (maxCacheBytes == null) {
                return Json.obj("changes", List.of());
            }

            long requested = Json.longValue(params, "resultMaxCacheBytes", -1L);
            if (requested < 0) {
                throw RpcException.invalidParams("resultMaxCacheBytes cannot be negative");
            }
            services.queries().setMaxCacheBytes(requested);

            return Json.obj("changes", List.of(
                    "resultMaxCacheBytes=" + services.queries().metricsPayload().get("maxCacheBytes")));
        });
    }
}
