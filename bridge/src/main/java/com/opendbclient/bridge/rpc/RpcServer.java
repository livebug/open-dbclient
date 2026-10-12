package com.opendbclient.bridge.rpc;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.json.JsonException;
import com.opendbclient.bridge.log.Log;

/**
 * Newline-delimited JSON request dispatcher, one instance per connection.
 *
 * <p>Two properties matter for correctness and are easy to get wrong:
 *
 * <ol>
 *   <li><b>Requests are dispatched concurrently.</b> A single-threaded dispatcher would
 *       make {@code query.cancel} unreachable while a query runs, because the reader
 *       thread would be blocked inside the query handler.</li>
 *   <li><b>Writes are serialised.</b> Multiple workers produce responses simultaneously,
 *       so every frame is written under one lock, otherwise interleaved partial lines
 *       would corrupt the stream beyond recovery.</li>
 * </ol>
 *
 * <p>Request counters and uptime are kept on a shared {@link ServerMetrics} so that in
 * {@code --listen} mode the health panel reports the whole process, while the worker pool
 * may be supplied by the caller so all connections share one. The per-connection
 * {@code active} set remains local so that closing one connection cancels only the
 * requests that came over it.
 */
public final class RpcServer implements EventSink {

    /** How long in-flight handlers get to finish after a stop request. */
    private static final long SHUTDOWN_GRACE_MILLIS = 3_000L;

    private final BufferedReader reader;
    private final PrintStream writer;

    /**
     * How to unblock a thread parked in {@link #serve()}.
     *
     * <p>Closing a {@link BufferedReader} whose {@code readLine()} is blocked does not reliably
     * wake it, and for a {@code FileInputStream}-backed reader it deadlocks: {@code close()} needs
     * the {@code StreamDecoder} lock that the blocked native read holds. The caller therefore
     * supplies a way to close the <em>raw</em> stream, whose close unblocks the read without
     * touching the reader's own lock.
     */
    private final Runnable unblock;

    private final ServerMetrics metrics;
    private final Map<String, Handler> handlers = new ConcurrentHashMap<>();

    /**
     * Shared secret every request must carry when non-null. Null means the server is open (stdio
     * mode, or a trusted intranet). Comparison is constant-time to avoid leaking the secret.
     */
    private final String requiredToken;

    /** Requests dispatched over this connection, so closing it cancels only its own work. */
    private final Set<RequestContext> active = ConcurrentHashMap.newKeySet();

    private final ExecutorService workers;
    private final boolean ownsWorkers;
    private final AtomicBoolean stopping = new AtomicBoolean(false);
    private final Object writeLock = new Object();

    /**
     * Action taken once a shutdown request has been acknowledged and in-flight work has
     * been drained. Defaults to terminating the process.
     */
    private volatile Runnable exitHook = () -> System.exit(0);

    public RpcServer(BufferedReader reader, PrintStream writer) {
        this(reader, writer, () -> {
            try {
                reader.close();
            } catch (IOException ignored) {
                // Closing stdin failing is not actionable; serve() also checks `stopping`.
            }
        });
    }

    public RpcServer(BufferedReader reader, PrintStream writer, Runnable unblock) {
        this(reader, writer, unblock, new ServerMetrics(), null, null);
    }

    /**
     * Full constructor: shared metrics and, optionally, a shared worker pool.
     *
     * <p>When {@code workers} is {@code null} the server creates its own pool and shuts it down in
     * {@link #stop()}; when it is supplied, the caller owns the pool's lifetime and {@code stop()}
     * leaves it running. {@code --listen} mode passes one shared pool.
     */
    public RpcServer(BufferedReader reader, PrintStream writer, Runnable unblock,
            ServerMetrics metrics, ExecutorService workers) {
        this(reader, writer, unblock, metrics, workers, null);
    }

    /** Full constructor with a shared secret required on every request. */
    public RpcServer(BufferedReader reader, PrintStream writer, Runnable unblock,
            ServerMetrics metrics, ExecutorService workers, String requiredToken) {
        this.reader = reader;
        this.writer = writer;
        this.unblock = unblock;
        this.metrics = metrics;
        this.requiredToken = requiredToken;
        this.ownsWorkers = workers == null;
        this.workers = workers != null
                ? workers
                : Executors.newFixedThreadPool(
                        Math.max(4, Runtime.getRuntime().availableProcessors()), new WorkerThreadFactory());
        Log.debug("rpc server using %s worker pool", ownsWorkers ? "its own" : "a shared");
    }

    /**
     * Replaces the action taken when the bridge is asked to exit.
     *
     * <p>Exists so tests can observe an orderly shutdown without terminating the test JVM.
     */
    public void setExitHook(Runnable hook) {
        this.exitHook = hook == null ? () -> System.exit(0) : hook;
    }

    /** Registers a handler, replacing any previous registration for the same method. */
    public void register(String method, Handler handler) {
        handlers.put(method, handler);
    }

    public int handlerCount() {
        return handlers.size();
    }

    public long requestsHandled() {
        return metrics.requestsHandled();
    }

    public long requestFailures() {
        return metrics.requestFailures();
    }

    public long uptimeMillis() {
        return metrics.uptimeMillis();
    }

    public int activeRequestCount() {
        return metrics.activeRequestCount();
    }

    /**
     * Reads frames until the stream reaches end-of-stream or a stop is requested.
     *
     * <p>This method blocks. It returns when the connection should be torn down: the client
     * closed the stream, or {@code system.shutdown} was requested.
     */
    public void serve() {
        Log.info("bridge connection ready; %d handlers registered", handlers.size());
        emit(Protocol.EVENT_READY, Json.obj(
                "pid", ProcessHandle.current().pid(),
                "javaVersion", System.getProperty("java.version"),
                "javaVendor", System.getProperty("java.vendor"),
                "maxHeapBytes", Runtime.getRuntime().maxMemory(),
                "handlers", handlers.size()));

        try {
            String line;
            while (!stopping.get() && (line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }
                dispatch(line);
            }
            Log.info("stream reached end of stream; connection stopping");
        } catch (IOException failure) {
            if (!stopping.get()) {
                Log.error("protocol read failed", failure);
            }
        } finally {
            stop();
        }
    }

    /**
     * Stops the server immediately.
     *
     * <p>Marks the loop as stopping <em>and</em> unblocks the reader, because setting a flag
     * alone would not wake a thread already parked inside {@code readLine()}. Use this for
     * process-level teardown and tests.
     *
     * <p>The {@code system.shutdown} handler deliberately does not call this - it uses
     * {@link RequestContext#requestShutdown()} so the acknowledgement is flushed first.
     */
    public void requestStop() {
        stopping.set(true);
        unblockReader();
    }

    // ------------------------------------------------------------------
    // dispatch
    // ------------------------------------------------------------------

    private void dispatch(String line) {
        Map<String, Object> request;
        try {
            request = Json.parseObject(line);
        } catch (JsonException malformed) {
            // Without a parsed frame there is no request id, so no response can be
            // addressed to the caller. Dropping is the only option.
            Log.warn("dropping malformed frame: %s", malformed.getMessage());
            return;
        }

        String id = Json.str(request, "id");
        String method = Json.str(request, "method");
        if (method == null) {
            fail(id, RpcException.invalidParams("frame is missing 'method'"));
            return;
        }

        if (requiredToken != null && !tokenMatches(requiredToken, Json.str(request, "token"))) {
            fail(id, new RpcException(Protocol.ERROR_UNAUTHORIZED, "unauthorized"));
            return;
        }

        Handler handler = handlers.get(method);
        if (handler == null) {
            fail(id, RpcException.unknownMethod(method));
            return;
        }

        Map<String, Object> params = Json.mapValue(request, "params");
        String tenantId = Json.str(request, "tenantId");
        String sessionId = Json.str(request, "sessionId");
        RequestContext ctx = new RequestContext(id, this, tenantId, sessionId);
        active.add(ctx);
        metrics.addActive();

        try {
            workers.execute(() -> {
                // Timed around the handler rather than around the frame, so the number is the work
                // the request asked for and not the time it spent queued behind another one. Pairing
                // it with the caller's own measurement is what separates "the bridge was busy" from
                // "the database was slow".
                long startNanos = System.nanoTime();
                try {
                    Object result = handler.handle(params, ctx);
                    respondResult(id, result);
                    metrics.recordHandled();
                    Log.debug("handled %s in %d ms", method, elapsedMillis(startNanos));
                } catch (RpcException known) {
                    fail(id, known);
                    Log.debug("%s failed after %d ms", method, elapsedMillis(startNanos));
                } catch (Throwable failure) {
                    fail(id, RpcException.fromThrowable(failure));
                    Log.debug("%s failed after %d ms", method, elapsedMillis(startNanos));
                } finally {
                    active.remove(ctx);
                    metrics.removeActive();
                    if (ctx.isShutdownRequested()) {
                        // The response is already on the wire by this point, so it is now
                        // safe to drain and exit.
                        terminate();
                    }
                }
            });
        } catch (RejectedExecutionException shuttingDown) {
            active.remove(ctx);
            metrics.removeActive();
            fail(id, new RpcException(Protocol.ERROR_INTERNAL, "the bridge is shutting down"));
        }
    }

    /** Milliseconds since a {@code System.nanoTime()} reading. */
    private static long elapsedMillis(long startNanos) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos);
    }

    /**
     * Drains in-flight work and then exits.
     *
     * <p>Runs on its own thread for two reasons. First, this is invoked from inside a worker
     * task, and {@link #stop()} waits for worker tasks to finish - calling it inline would
     * have the task wait on itself. Second, the process cannot rely on unblocking the
     * protocol reader to unwind {@link #serve()}: closing a stream never reliably interrupts
     * a thread already parked in a blocking read, so an explicit exit is the only way to
     * guarantee the bridge actually terminates when the extension asks it to.
     */
    private void terminate() {
        Thread terminator = new Thread(() -> {
            stop();
            Log.info("bridge exiting");
            try {
                exitHook.run();
            } catch (Throwable failure) {
                Log.error("exit hook failed", failure);
            }
        }, "bridge-terminator");
        terminator.setDaemon(false);
        terminator.start();
    }

    private void respondResult(String id, Object result) {
        if (id == null) {
            // Notification frame: by contract it has no response.
            Log.trace("completed notification with no response");
            return;
        }
        Map<String, Object> frame = Json.obj("id", id, "ok", Boolean.TRUE);
        frame.put("result", result == null ? Json.obj() : result);
        writeLine(Json.write(frame));
    }

    /**
     * Counts and reports a failure.
     *
     * <p>Every failure path funnels through here so the failure counter cannot drift away
     * from reality. Failures detected on the reader thread (unknown method, missing
     * {@code method}) are just as real as ones thrown by a handler, and counting only the
     * latter made the health panel under-report.
     */
    private void fail(String id, RpcException failure) {
        metrics.recordFailure();
        respondError(id, failure);
    }

    private void respondError(String id, RpcException failure) {
        Log.debug("request failed [%s] %s", failure.code(), failure.getMessage());
        if (id == null) {
            Log.warn("dropping error for unaddressable frame: %s", failure.getMessage());
            return;
        }
        writeLine(Json.write(Json.obj(
                "id", id,
                "ok", Boolean.FALSE,
                "error", failure.toPayload())));
    }

    @Override
    public void emit(String method, Map<String, Object> params) {
        Map<String, Object> frame = Json.obj("type", "event", "method", method);
        if (params != null) {
            frame.put("params", params);
        }
        writeLine(Json.write(frame));
    }

    private void writeLine(String json) {
        synchronized (writeLock) {
            writer.print(json);
            writer.print('\n');
            writer.flush();
        }
    }

    // ------------------------------------------------------------------
    // shutdown
    // ------------------------------------------------------------------

    private void unblockReader() {
        try {
            unblock.run();
        } catch (RuntimeException ignored) {
            // Unblocking is best-effort; the explicit exit in terminate() is the guarantee.
        }
    }

    private void stop() {
        if (!stopping.compareAndSet(false, true)) {
            return;
        }
        Log.info("connection stopping after %d requests (%d failures)",
                metrics.requestsHandled(), metrics.requestFailures());

        for (RequestContext ctx : active) {
            ctx.markCancelled();
        }

        if (ownsWorkers) {
            workers.shutdown();
            try {
                if (!workers.awaitTermination(SHUTDOWN_GRACE_MILLIS, TimeUnit.MILLISECONDS)) {
                    Log.warn("forcing shutdown: %d handlers still running", active.size());
                    workers.shutdownNow();
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                workers.shutdownNow();
            }
        }
        unblockReader();
    }

    private static boolean tokenMatches(String expected, String actual) {
        if (actual == null) {
            return false;
        }
        return MessageDigest.isEqual(
                expected.getBytes(StandardCharsets.UTF_8),
                actual.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Worker threads are daemons so a forgotten driver thread can never keep the JVM alive;
     * {@code BridgeMain} calls {@code System.exit} explicitly once the server returns.
     */
    private static final class WorkerThreadFactory implements ThreadFactory {

        private final AtomicInteger counter = new AtomicInteger();

        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "rpc-worker-" + counter.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        }
    }
}
