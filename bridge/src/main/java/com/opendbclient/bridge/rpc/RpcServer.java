package com.opendbclient.bridge.rpc;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.PrintStream;
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
import java.util.concurrent.atomic.AtomicLong;

import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.json.JsonException;
import com.opendbclient.bridge.log.Log;

/**
 * Newline-delimited JSON request dispatcher.
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
 */
public final class RpcServer implements EventSink {

    /** How long in-flight handlers get to finish after a stop request. */
    private static final long SHUTDOWN_GRACE_MILLIS = 3_000L;

    private final BufferedReader reader;
    private final PrintStream writer;
    private final Map<String, Handler> handlers = new ConcurrentHashMap<>();
    private final Set<RequestContext> active = ConcurrentHashMap.newKeySet();
    private final ExecutorService workers;
    private final AtomicBoolean stopping = new AtomicBoolean(false);
    private final AtomicLong requestsHandled = new AtomicLong();
    private final AtomicLong requestFailures = new AtomicLong();
    private final long startedAtNanos = System.nanoTime();
    private final Object writeLock = new Object();

    /**
     * Action taken once a shutdown request has been acknowledged and in-flight work has
     * been drained. Defaults to terminating the process.
     */
    private volatile Runnable exitHook = () -> System.exit(0);

    public RpcServer(BufferedReader reader, PrintStream writer) {
        this.reader = reader;
        this.writer = writer;
        int parallelism = Math.max(4, Runtime.getRuntime().availableProcessors());
        this.workers = Executors.newFixedThreadPool(parallelism, new WorkerThreadFactory());
        Log.debug("rpc server using %d worker threads", parallelism);
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
        return requestsHandled.get();
    }

    public long requestFailures() {
        return requestFailures.get();
    }

    public long uptimeMillis() {
        return (System.nanoTime() - startedAtNanos) / 1_000_000L;
    }

    public int activeRequestCount() {
        return active.size();
    }

    /**
     * Reads frames until {@code stdin} reaches end-of-stream or a stop is requested.
     *
     * <p>This method blocks. It returns only when the bridge should terminate, which
     * happens when the extension host closes our stdin (the normal case: the window was
     * closed or the extension was disabled).
     */
    public void serve() {
        Log.info("bridge ready; %d handlers registered", handlers.size());
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
            Log.info("stdin reached end of stream; bridge stopping");
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

        Handler handler = handlers.get(method);
        if (handler == null) {
            fail(id, RpcException.unknownMethod(method));
            return;
        }

        Map<String, Object> params = Json.mapValue(request, "params");
        RequestContext ctx = new RequestContext(id, this);
        active.add(ctx);

        try {
            workers.execute(() -> {
                try {
                    Object result = handler.handle(params, ctx);
                    respondResult(id, result);
                    requestsHandled.incrementAndGet();
                } catch (RpcException known) {
                    fail(id, known);
                } catch (Throwable failure) {
                    fail(id, RpcException.fromThrowable(failure));
                } finally {
                    active.remove(ctx);
                    if (ctx.isShutdownRequested()) {
                        // The response is already on the wire by this point, so it is now
                        // safe to drain and exit.
                        terminate();
                    }
                }
            });
        } catch (RejectedExecutionException shuttingDown) {
            active.remove(ctx);
            fail(id, new RpcException(Protocol.ERROR_INTERNAL, "the bridge is shutting down"));
        }
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
        requestFailures.incrementAndGet();
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
            reader.close();
        } catch (IOException ignored) {
            // Closing stdin failing is not actionable; serve() also checks `stopping`.
        }
    }

    private void stop() {
        if (!stopping.compareAndSet(false, true)) {
            return;
        }
        Log.info("bridge stopping after %d requests (%d failures)",
                requestsHandled.get(), requestFailures.get());

        for (RequestContext ctx : active) {
            ctx.markCancelled();
        }

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
        unblockReader();
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
