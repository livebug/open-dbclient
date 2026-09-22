package com.opendbclient.bridge.rpc;

import java.util.Map;

/**
 * Handles a single RPC method.
 *
 * <p>Handlers run on a worker thread, never on the protocol reader thread. That is what
 * makes {@code query.cancel} possible: a long-running {@code query.execute} occupies one
 * worker while {@code query.cancel} is served by another.
 *
 * <p>Returning {@code null} produces a response with a {@code null} result. Throwing
 * {@link RpcException} produces a structured error frame; any other exception is mapped
 * through {@link RpcException#fromThrowable(Throwable)}.
 */
@FunctionalInterface
public interface Handler {

    Object handle(Map<String, Object> params, RequestContext ctx) throws Exception;
}
