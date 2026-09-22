package com.opendbclient.bridge.rpc;

import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import com.opendbclient.bridge.json.Json;

/**
 * Per-request state handed to a {@link Handler}.
 *
 * <p>Carries the cancellation flag and the event sink, plus the request id so progress
 * events can be correlated with the frame that triggered them.
 *
 * <p>Cancellation is cooperative by design. A long-running handler is expected to poll
 * {@link #isCancelled()} at natural checkpoints and stop early; the bridge additionally
 * calls {@link java.sql.Statement#cancel()} from the cancelling thread, which is what
 * actually interrupts a database that is busy computing.
 */
public final class RequestContext {

    private final String requestId;
    private final EventSink events;
    private final AtomicBoolean cancelled = new AtomicBoolean(false);
    private final AtomicBoolean shutdownRequested = new AtomicBoolean(false);

    RequestContext(String requestId, EventSink events) {
        this.requestId = requestId;
        this.events = events;
    }

    public String requestId() {
        return requestId;
    }

    public EventSink events() {
        return events;
    }

    public boolean isCancelled() {
        return cancelled.get();
    }

    /** Signals cancellation. Called either by {@code query.cancel} or during shutdown. */
    public void markCancelled() {
        cancelled.set(true);
    }

    /**
     * Throws when this request has been cancelled.
     *
     * <p>Handlers should call this inside result-set loops so a cancelled query stops
     * promptly instead of streaming megabytes nobody wants.
     *
     * @throws RpcException with code {@code QUERY_CANCELLED}
     */
    public void throwIfCancelled() {
        if (cancelled.get()) {
            throw new RpcException(Protocol.ERROR_QUERY_CANCELLED, "query was cancelled");
        }
    }

    /**
     * Emits a {@code query.progress} event tied to this request.
     *
     * @param rowsProcessed rows handled so far
     * @param totalRows      total rows if known, otherwise {@code null}
     */
    public void progress(long rowsProcessed, Long totalRows) {
        Map<String, Object> payload = Json.obj("requestId", requestId, "rows", rowsProcessed);
        if (totalRows != null) {
            payload.put("totalRows", totalRows);
        }
        events.emit(Protocol.EVENT_QUERY_PROGRESS, payload);
    }

    /** Emits a free-form progress event carrying an extra message. */
    public void progress(String message) {
        events.emit(Protocol.EVENT_QUERY_PROGRESS, Json.obj("requestId", requestId, "message", message));
    }

    /** Emits a progress event describing the current phase together with a row count. */
    public void progress(String phase, long rowsProcessed) {
        events.emit(Protocol.EVENT_QUERY_PROGRESS,
                Json.obj("requestId", requestId, "phase", phase, "rows", rowsProcessed));
    }

    /**
     * Requests that the bridge exit once this response has been flushed.
     *
     * <p>Deferred rather than immediate on purpose: closing the protocol channel from inside
     * the handler would race the response write, and the extension would never see the
     * acknowledgement of its own shutdown request.
     */
    public void requestShutdown() {
        shutdownRequested.set(true);
    }

    boolean isShutdownRequested() {
        return shutdownRequested.get();
    }
}
