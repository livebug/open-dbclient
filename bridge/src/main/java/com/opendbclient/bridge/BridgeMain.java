package com.opendbclient.bridge;

import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.rpc.RpcServer;
import com.opendbclient.bridge.rpc.ServerMetrics;

/**
 * Entry point of the JDBC bridge process.
 *
 * <p>The bridge is a plain {@code java -jar} program with no third-party dependencies. It speaks
 * newline-delimited JSON, and runs in one of two modes:
 *
 * <ul>
 *   <li>{@code --stdio} (default): one connection over {@code stdin}/{@code stdout}, driven by the
 *       VS Code extension.</li>
 *   <li>{@code --listen <port>}: a shared server. It accepts any number of TCP connections, all of
 *       them served by one set of loaded drivers, one connection registry and one result cache, so
 *       many clients can share a single JVM instead of each spawning its own.</li>
 * </ul>
 *
 * <h2>Why the stream setup at the top of {@link #main} is not negotiable</h2>
 *
 * <p>Every JDBC driver is written on the assumption that it owns {@code System.out}; plenty of them
 * print banners, deprecation notices and debug output to it. In stdio mode {@code stdout} is the
 * protocol channel, so a single stray {@code println} from a driver would inject a line that the
 * client cannot parse. The fix has to happen before a driver class is ever loaded:
 *
 * <ol>
 *   <li>Bind an explicit UTF-8 stream to the real file descriptor {@code 1} - this becomes the
 *       protocol writer and is never handed to anything else.</li>
 *   <li>Repoint {@code System.out} at {@code stderr}. Driver chatter now lands in the log where it
 *       is useful instead of on the wire where it is fatal.</li>
 * </ol>
 */
public final class BridgeMain {

    private BridgeMain() {
    }

    public static void main(String[] args) {
        // --- 1. Claim stdout for the protocol, before any driver can touch it. --------
        PrintStream protocolOut = new PrintStream(
                new FileOutputStream(FileDescriptor.out), false, StandardCharsets.UTF_8);

        // --- 2. Redirect System.out to stderr so driver chatter cannot corrupt it. ----
        PrintStream diagnostics = new PrintStream(
                new FileOutputStream(FileDescriptor.err), true, StandardCharsets.UTF_8);
        System.setOut(diagnostics);
        System.setErr(diagnostics);

        Log.init(Log.Level.parse(firstNonBlank(
                System.getProperty("opendbclient.logLevel"),
                System.getenv("OPEN_DBCLIENT_LOG_LEVEL"))));

        Log.info("open-dbclient bridge %s starting (pid %d)",
                BuildInfo.VERSION, ProcessHandle.current().pid());
        Log.info("java %s (%s), max heap %d MiB",
                System.getProperty("java.version"),
                System.getProperty("java.vendor"),
                Runtime.getRuntime().maxMemory() / (1024 * 1024));

        Args parsed = parseArgs(args);
        if (parsed.listenPort() > 0) {
            runListenServer(parsed.listenPort(), parsed.token(), diagnostics);
        } else {
            runStdio(protocolOut, diagnostics);
        }
    }

    /** {@code --stdio} (default): one connection over stdin/stdout, owned by the caller. */
    private static void runStdio(PrintStream protocolOut, PrintStream diagnostics) {
        FileInputStream rawIn = new FileInputStream(FileDescriptor.in);
        BufferedReader protocolIn = new BufferedReader(
                new InputStreamReader(rawIn, StandardCharsets.UTF_8));

        // The server unblocks a blocked readLine() by closing the raw stream, not the reader:
        // closing a BufferedReader whose readLine() is parked deadlocks on the StreamDecoder lock.
        RpcServer server = new RpcServer(protocolIn, protocolOut, () -> {
            try {
                rawIn.close();
            } catch (IOException ignored) {
                // Best-effort; the explicit process exit is the real guarantee.
            }
        });
        BridgeServices services = new BridgeServices(new ServerMetrics());
        registerShutdownHook(services, null, protocolOut, diagnostics);
        services.registerHandlers(server);

        try {
            server.serve();
        } catch (Throwable fatal) {
            Log.error("bridge terminated abnormally", fatal);
        } finally {
            services.close();
        }

        // Drivers routinely spawn non-daemon threads (connection reapers, keepalive timers,
        // Kerberos refresh loops). Returning from main would leave the JVM waiting on them
        // forever, so exit explicitly once the protocol work is done.
        System.exit(0);
    }

    /** {@code --listen <port>}: a shared server serving any number of connections. */
    private static void runListenServer(int port, String token, PrintStream diagnostics) {
        ServerMetrics metrics = new ServerMetrics();
        BridgeServices services = new BridgeServices(metrics);
        ExecutorService workers = newWorkerPool();
        registerShutdownHook(services, workers, null, diagnostics);

        try (ServerSocket serverSocket = new ServerSocket(port)) {
            Log.info("bridge %s listening on port %d%s", BuildInfo.VERSION, port,
                    token == null ? "" : " (token required)");
            while (true) {
                Socket socket = serverSocket.accept();
                socket.setTcpNoDelay(true);
                Thread connection = new Thread(
                        () -> handleConnection(socket, services, metrics, workers, token),
                        "bridge-connection");
                connection.setDaemon(false);
                connection.start();
            }
        } catch (IOException failure) {
            Log.error("listener on port %d failed: %s", port, failure.getMessage());
        } finally {
            workers.shutdownNow();
            services.close();
        }
    }

    private static void handleConnection(
            Socket socket, BridgeServices services, ServerMetrics metrics, ExecutorService workers,
            String requiredToken) {
        try (socket) {
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            PrintStream writer = new PrintStream(socket.getOutputStream(), false, StandardCharsets.UTF_8);
            RpcServer server = new RpcServer(reader, writer,
                    () -> {
                        try {
                            socket.close();
                        } catch (IOException ignored) {
                            // Best-effort; serve() also checks its stopping flag.
                        }
                    },
                    metrics, workers, requiredToken);
            services.registerHandlers(server);
            server.serve();
        } catch (IOException failure) {
            Log.debug("connection ended: %s", failure.getMessage());
        }
    }

    private static ExecutorService newWorkerPool() {
        AtomicInteger counter = new AtomicInteger();
        return Executors.newFixedThreadPool(
                Math.max(4, Runtime.getRuntime().availableProcessors()),
                runnable -> {
                    Thread thread = new Thread(runnable, "rpc-worker-" + counter.incrementAndGet());
                    thread.setDaemon(true);
                    return thread;
                });
    }

    private static void registerShutdownHook(
            BridgeServices services, ExecutorService workers, PrintStream protocolOut, PrintStream diagnostics) {
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            Log.info("shutdown hook: closing connections and flushing streams");
            try {
                services.close();
            } finally {
                if (workers != null) {
                    workers.shutdownNow();
                }
                if (protocolOut != null) {
                    try {
                        protocolOut.flush();
                    } catch (RuntimeException ignored) {
                        // The stream may already be gone; nothing to do.
                    }
                }
                diagnostics.flush();
            }
        }, "bridge-shutdown"));
    }

    private record Args(int listenPort, String token) {
    }

    private static Args parseArgs(String[] args) {
        int listenPort = -1;
        String token = null;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--stdio" -> {
                    return new Args(-1, null);
                }
                case "--listen", "-p", "--port" -> {
                    if (i + 1 >= args.length) {
                        Log.error("%s requires a port number", args[i]);
                        System.exit(2);
                    }
                    try {
                        int port = Integer.parseInt(args[++i]);
                        if (port <= 0 || port > 65535) {
                            throw new NumberFormatException();
                        }
                        listenPort = port;
                    } catch (NumberFormatException invalid) {
                        Log.error("invalid port: %s", args[i]);
                        System.exit(2);
                    }
                }
                case "--token" -> {
                    if (i + 1 >= args.length) {
                        Log.error("--token requires a value");
                        System.exit(2);
                    }
                    token = args[++i];
                }
                default -> Log.warn("ignoring unknown argument: %s", args[i]);
            }
        }
        return new Args(listenPort, token);
    }

    private static String firstNonBlank(String... candidates) {
        for (String candidate : candidates) {
            if (candidate != null && !candidate.isBlank()) {
                return candidate;
            }
        }
        return null;
    }
}
