package com.opendbclient.bridge.rpc;

import java.util.Map;

/**
 * Destination for unsolicited bridge-to-extension messages.
 *
 * <p>Events are the only frames the bridge originates without a matching request. They are
 * used for periodic health pushes, long-running query progress, and log forwarding.
 */
public interface EventSink {

    /**
     * Pushes an event frame.
     *
     * @param method one of the {@code Protocol.EVENT_*} constants
     * @param params event payload; may be {@code null}
     */
    void emit(String method, Map<String, Object> params);

    /** Convenience overload for events that carry no payload. */
    default void emit(String method) {
        emit(method, null);
    }
}
