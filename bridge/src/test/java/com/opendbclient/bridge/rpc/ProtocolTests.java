package com.opendbclient.bridge.rpc;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.io.PipedReader;
import java.io.PipedWriter;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import com.opendbclient.bridge.Assert;
import com.opendbclient.bridge.TestRunner;
import com.opendbclient.bridge.handler.SystemHandlers;
import com.opendbclient.bridge.json.Json;

/**
 * Tests for request dispatch, framing and error mapping.
 *
 * <p>These run the real {@link RpcServer} over in-memory pipes rather than mocking it,
 * because the properties worth protecting here are emergent: frame integrity under
 * malformed input, and the ordering guarantee that makes cancellation possible.
 */
public final class ProtocolTests {

    private ProtocolTests() {
    }

    public static void register(TestRunner runner) {
        runner.test("emits a ready event on startup", ProtocolTests::emitsReadyEvent);
        runner.test("dispatches a registered handler", ProtocolTests::dispatchesHandler);
        runner.test("answers null results with an empty object", ProtocolTests::nullResult);
        runner.test("reports unknown methods as UNKNOWN_METHOD", ProtocolTests::unknownMethod);
        runner.test("drops malformed frames without corrupting the stream", ProtocolTests::malformedFrameIsIsolated);
        runner.test("maps SQLException to a structured error", ProtocolTests::sqlExceptionIsStructured);
        runner.test("unwraps a SQLException nested inside another exception", ProtocolTests::nestedSqlException);
        runner.test("reports malformed parameters as INVALID_PARAMS", ProtocolTests::invalidParams);
        runner.test("dispatches requests concurrently", ProtocolTests::concurrentDispatch);
        runner.test("counts failures detected on the reader thread", ProtocolTests::failuresAreCounted);
        runner.test("correlates progress events with their request", ProtocolTests::progressEvents);
        runner.test("acknowledges shutdown and then terminates", ProtocolTests::shutdownTerminates);
    }

    // ------------------------------------------------------------------
    // tests
    // ------------------------------------------------------------------

    private static void emitsReadyEvent() throws IOException {
        try (Harness harness = new Harness()) {
            harness.start();
            Map<String, Object> event = harness.awaitEvent("bridge.ready", 5_000);
            Assert.equal("event", event.get("type"), "frame type");
            Assert.notNull(Json.mapValue(event, "params").get("pid"), "pid in ready payload");
        }
    }

    private static void dispatchesHandler() throws IOException {
        try (Harness harness = new Harness()) {
            harness.start();
            harness.send(request("1", "system.ping"));
            Map<String, Object> response = harness.awaitResponse("1", 5_000);
            Assert.equal(Boolean.TRUE, response.get("ok"), "ok flag");
            Assert.equal(Boolean.TRUE, harness.resultOf(response).get("pong"), "pong payload");
        }
    }

    private static void nullResult() throws IOException {
        try (Harness harness = new Harness()) {
            harness.server().register("test.null", (params, ctx) -> null);
            harness.start();
            harness.send(request("1", "test.null"));
            Map<String, Object> response = harness.awaitResponse("1", 5_000);
            Assert.equal(Boolean.TRUE, response.get("ok"), "ok flag");
            Assert.equal(0, harness.resultOf(response).size(), "null result should serialise as an empty object");
        }
    }

    private static void unknownMethod() throws IOException {
        try (Harness harness = new Harness()) {
            harness.start();
            harness.send(request("1", "does.not.exist"));
            Map<String, Object> error = harness.errorOf(harness.awaitResponse("1", 5_000));
            Assert.equal("UNKNOWN_METHOD", error.get("code"), "error code");
        }
    }

    /**
     * The single most important regression test in the bridge.
     *
     * A malformed frame must be dropped, must not produce a response, and above all must
     * leave the channel usable for the next frame. If this ever fails, the extension will
     * see responses attributed to the wrong requests.
     */
    private static void malformedFrameIsIsolated() throws IOException {
        try (Harness harness = new Harness()) {
            harness.start();
            harness.send("{\"id\":\"bad\",\"method\":\"system.ping\"");
            harness.send(request("2", "system.ping"));

            Map<String, Object> response = harness.awaitResponse("2", 5_000);
            Assert.equal(Boolean.TRUE, response.get("ok"), "frame following a malformed one still works");
            Assert.equal(-1, harness.indexOfResponse("bad"), "malformed frame must not be answered");
            Assert.equal(List.of(), harness.unparseableFrames(),
                    "every line on the wire must be a complete JSON frame");
        }
    }

    private static void sqlExceptionIsStructured() throws IOException {
        try (Harness harness = new Harness()) {
            harness.server().register("test.fail", (params, ctx) -> {
                throw new SQLException("relation \"users\" does not exist", "42P01", 1234);
            });
            harness.start();
            harness.send(request("1", "test.fail"));

            Map<String, Object> error = harness.errorOf(harness.awaitResponse("1", 5_000));
            Assert.equal("SQL_ERROR", error.get("code"), "error code");
            Assert.equal("42P01", error.get("sqlState"), "SQLState is preserved");
            Assert.equal(1234L, error.get("errorCode"), "vendor error code is preserved");
            Assert.that(String.valueOf(error.get("message")).contains("does not exist"),
                    "message is preserved, got " + error.get("message"));
        }
    }

    private static void nestedSqlException() throws IOException {
        try (Harness harness = new Harness()) {
            harness.server().register("test.wrapped", (params, ctx) -> {
                throw new IllegalStateException("pool gave up",
                        new SQLException("duplicate key value violates unique constraint", "23505", 99));
            });
            harness.start();
            harness.send(request("1", "test.wrapped"));

            Map<String, Object> error = harness.errorOf(harness.awaitResponse("1", 5_000));
            Assert.equal("SQL_ERROR", error.get("code"), "wrapped SQL failure is still classified as SQL");
            Assert.equal("23505", error.get("sqlState"),
                    "the SQLException buried in the cause chain must be found");
        }
    }

    /**
     * A handler rejecting its parameters must not be reported as a bridge defect.
     *
     * {@code Json.requireStr} raises {@code JsonException} for a missing field. Without explicit
     * mapping that reaches the caller as INTERNAL_ERROR, which sends users looking for a bug in
     * the bridge instead of fixing their input.
     */
    private static void invalidParams() throws IOException {
        try (Harness harness = new Harness()) {
            harness.server().register("test.requiresParam", (params, ctx) -> Json.obj(
                    "value", Json.requireStr(params, "requiredField")));
            harness.start();

            harness.send(request("1", "test.requiresParam"));
            Map<String, Object> error = harness.errorOf(harness.awaitResponse("1", 5_000));
            Assert.equal("INVALID_PARAMS", error.get("code"),
                    "a missing parameter is the caller's error, not an internal failure");
            Assert.that(String.valueOf(error.get("message")).contains("requiredField"),
                    "the error names the offending parameter, got " + error.get("message"));

            harness.send("{\"id\":\"2\",\"method\":\"test.requiresParam\","
                    + "\"params\":{\"requiredField\":\"ok\"}}");
            Assert.equal("ok", harness.resultOf(harness.awaitResponse("2", 5_000)).get("value"),
                    "the same handler succeeds once the parameter is supplied");
        }
    }

    /**
     * Proves requests are not serialised behind one another.
     *
     * If this regresses, {@code query.cancel} becomes unreachable while a query is running,
     * because the only thread able to serve it would be busy executing the query.
     */
    private static void concurrentDispatch() throws IOException {
        try (Harness harness = new Harness()) {
            harness.server().register("test.slow", (params, ctx) -> {
                Thread.sleep(500);
                return Json.obj("slow", Boolean.TRUE);
            });
            harness.start();

            harness.send(request("slow", "test.slow"));
            harness.send(request("fast", "system.ping"));

            harness.awaitResponse("fast", 5_000);
            harness.awaitResponse("slow", 5_000);

            int fastIndex = harness.indexOfResponse("fast");
            int slowIndex = harness.indexOfResponse("slow");
            Assert.that(fastIndex >= 0 && slowIndex >= 0 && fastIndex < slowIndex,
                    "the fast request must be answered before the slow one (fast=" + fastIndex
                            + ", slow=" + slowIndex + "); a serialised dispatcher would make cancellation impossible");
        }
    }

    private static void failuresAreCounted() throws IOException {
        try (Harness harness = new Harness()) {
            harness.start();

            harness.send(request("p", "system.ping"));
            harness.awaitResponse("p", 5_000);

            harness.send(request("u", "nope.not.registered"));
            harness.awaitResponse("u", 5_000);

            // A request cannot observe its own completion: the handled counter is bumped
            // after the handler returns and the response is written. So the counters are
            // inspected from a later request than the ones being measured.
            harness.send(request("i", "system.info"));
            Map<String, Object> info = harness.resultOf(harness.awaitResponse("i", 5_000));

            Assert.that(((Number) info.get("requestFailures")).longValue() >= 1,
                    "failures raised on the reader thread must be counted, got "
                            + info.get("requestFailures"));
            Assert.that(((Number) info.get("requestsHandled")).longValue() >= 1,
                    "the completed ping should be counted, got " + info.get("requestsHandled"));
        }
    }

    private static void progressEvents() throws IOException {
        try (Harness harness = new Harness()) {
            harness.server().register("test.progress", (params, ctx) -> {
                ctx.progress(42L, null);
                return Json.obj("done", Boolean.TRUE);
            });
            harness.start();
            harness.send(request("p", "test.progress"));

            Map<String, Object> params = Json.mapValue(harness.awaitEvent("query.progress", 5_000), "params");
            Assert.equal("p", params.get("requestId"), "progress carries the originating request id");
            Assert.equal(42L, params.get("rows"), "row count");

            harness.awaitResponse("p", 5_000);
        }
    }

    /**
     * Verifies shutdown reaches the point of process termination.
     *
     * The assertion is on the exit hook rather than on the server thread dying, because
     * {@link RpcServer#serve()} does not necessarily return: closing a stream does not wake a
     * thread already blocked in a read, so an explicit exit is what actually ends the bridge.
     */
    private static void shutdownTerminates() throws Exception {
        try (Harness harness = new Harness()) {
            CountDownLatch exited = new CountDownLatch(1);
            harness.server().setExitHook(exited::countDown);
            harness.start();

            harness.send(request("s", "system.shutdown"));

            Map<String, Object> response = harness.awaitResponse("s", 5_000);
            Assert.equal(Boolean.TRUE, response.get("ok"), "shutdown is acknowledged");
            Assert.equal(Boolean.TRUE, harness.resultOf(response).get("stopping"), "stopping flag");

            Assert.that(exited.await(5, TimeUnit.SECONDS),
                    "the bridge must reach process termination after acknowledging shutdown");
        }
    }

    // ------------------------------------------------------------------
    // harness
    // ------------------------------------------------------------------

    private static String request(String id, String method) {
        return Json.write(Json.obj("id", id, "method", method, "params", Json.obj()));
    }

    /**
     * Drives a real {@link RpcServer} over in-memory pipes.
     *
     * Frames produced by the server are read on a separate thread and parsed; anything that
     * fails to parse is recorded rather than thrown, which lets tests assert that the wire
     * carried nothing but well-formed frames.
     */
    private static final class Harness implements AutoCloseable {

        private final PipedWriter clientInput = new PipedWriter();
        private final PipedInputStream capturedOutput;
        private final PipedOutputStream serverOutputPipe = new PipedOutputStream();
        private final PrintStream protocolOut;
        private final RpcServer server;
        private final Thread serverThread;
        private final Thread drainThread;
        private final List<Map<String, Object>> frames = new ArrayList<>();
        private final List<String> unparseable = new ArrayList<>();

        Harness() throws IOException {
            capturedOutput = new PipedInputStream(serverOutputPipe, 64 * 1024);
            protocolOut = new PrintStream(serverOutputPipe, false, StandardCharsets.UTF_8);
            server = new RpcServer(new BufferedReader(new PipedReader(clientInput)), protocolOut);
            SystemHandlers.register(server);

            // Never let a test terminate the test JVM by accident. Cases that care about
            // shutdown install their own hook.
            server.setExitHook(() -> { });

            serverThread = new Thread(server::serve, "test-server");
            serverThread.setDaemon(true);
            drainThread = new Thread(this::drainFrames, "test-drain");
            drainThread.setDaemon(true);
        }

        RpcServer server() {
            return server;
        }

        void start() {
            serverThread.start();
            drainThread.start();
        }

        void send(String frame) throws IOException {
            clientInput.write(frame);
            clientInput.write('\n');
            clientInput.flush();
        }

        List<Map<String, Object>> snapshot() {
            synchronized (frames) {
                return new ArrayList<>(frames);
            }
        }

        List<String> unparseableFrames() {
            synchronized (unparseable) {
                return new ArrayList<>(unparseable);
            }
        }

        Map<String, Object> awaitResponse(String id, long timeoutMillis) {
            long deadline = System.currentTimeMillis() + timeoutMillis;
            while (System.currentTimeMillis() < deadline) {
                for (Map<String, Object> frame : snapshot()) {
                    if (id.equals(frame.get("id")) && frame.containsKey("ok")) {
                        return frame;
                    }
                }
                pause();
            }
            throw new AssertionError("timed out waiting for a response to '" + id + "'; frames seen: " + snapshot());
        }

        Map<String, Object> awaitEvent(String method, long timeoutMillis) {
            long deadline = System.currentTimeMillis() + timeoutMillis;
            while (System.currentTimeMillis() < deadline) {
                for (Map<String, Object> frame : snapshot()) {
                    if ("event".equals(frame.get("type")) && method.equals(frame.get("method"))) {
                        return frame;
                    }
                }
                pause();
            }
            throw new AssertionError("timed out waiting for event '" + method + "'; frames seen: " + snapshot());
        }

        int indexOfResponse(String id) {
            List<Map<String, Object>> current = snapshot();
            for (int i = 0; i < current.size(); i++) {
                if (id.equals(current.get(i).get("id")) && current.get(i).containsKey("ok")) {
                    return i;
                }
            }
            return -1;
        }

        Map<String, Object> resultOf(Map<String, Object> response) {
            return Json.mapValue(response, "result");
        }

        Map<String, Object> errorOf(Map<String, Object> response) {
            return Json.mapValue(response, "error");
        }

        boolean awaitServerExit(long timeoutMillis) {
            try {
                serverThread.join(timeoutMillis);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return !serverThread.isAlive();
        }

        private void drainFrames() {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(capturedOutput, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.isBlank()) {
                        continue;
                    }
                    try {
                        Map<String, Object> frame = Json.parseObject(line);
                        synchronized (frames) {
                            frames.add(frame);
                        }
                    } catch (RuntimeException malformed) {
                        synchronized (unparseable) {
                            unparseable.add(line);
                        }
                    }
                }
            } catch (IOException closed) {
                // Expected: close() shuts the pipe down after the server has stopped.
            }
        }

        private static void pause() {
            try {
                Thread.sleep(10);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }

        @Override
        public void close() {
            server.requestStop();
            awaitServerExit(3_000);
            protocolOut.flush();
            try {
                serverOutputPipe.close();
            } catch (IOException ignored) {
                // Already closed.
            }
            try {
                drainThread.join(2_000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            try {
                clientInput.close();
            } catch (IOException ignored) {
                // Already closed.
            }
        }
    }
}
