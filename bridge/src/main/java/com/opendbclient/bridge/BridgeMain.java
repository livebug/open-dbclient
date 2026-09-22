package com.opendbclient.bridge;

import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;

import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.rpc.RpcServer;

/**
 * Entry point of the JDBC bridge process.
 *
 * <p>The bridge is a plain {@code java -jar} program with no third-party dependencies. It
 * speaks newline-delimited JSON over {@code stdin}/{@code stdout} and is driven entirely by
 * the VS Code extension.
 *
 * <h2>Why the stream setup at the top of {@link #main} is not negotiable</h2>
 *
 * <p>Every JDBC driver is written on the assumption that it owns {@code System.out}; plenty
 * of them print banners, deprecation notices and debug output to it. Since {@code stdout} is
 * our protocol channel, a single stray {@code println} from a driver would inject a line
 * that the extension cannot parse, and depending on timing it could land in the middle of a
 * response. There is no way to recover from that after the fact, so the fix has to happen
 * before a driver class is ever loaded:
 *
 * <ol>
 *   <li>Bind an explicit UTF-8 stream to the real file descriptor {@code 1} - this becomes
 *       the protocol writer and is never handed to anything else.</li>
 *   <li>Repoint {@code System.out} at {@code stderr}. Driver chatter now lands in the log
 *       where it is useful instead of on the wire where it is fatal.</li>
 *   <li>Build the protocol reader over an explicit UTF-8 stream too, so non-ASCII data
 *       (CJK table names, for instance) survives regardless of the platform default
 *       encoding.</li>
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

        BufferedReader protocolIn = new BufferedReader(
                new InputStreamReader(new FileInputStream(FileDescriptor.in), StandardCharsets.UTF_8));

        // Flush anything buffered when the extension terminates us abruptly.
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            Log.info("shutdown hook: flushing protocol stream");
            protocolOut.flush();
            diagnostics.flush();
        }, "bridge-shutdown"));

        RpcServer server = new RpcServer(protocolIn, protocolOut);
        BridgeServices services = new BridgeServices(server);
        services.registerHandlers();

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

    private static String firstNonBlank(String... candidates) {
        for (String candidate : candidates) {
            if (candidate != null && !candidate.isBlank()) {
                return candidate;
            }
        }
        return null;
    }
}
