package com.opendbclient.bridge.log;

import java.io.PrintStream;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;

/**
 * Leveled logger that writes to {@code stderr} only.
 *
 * <p>This is load-bearing, not a style choice. The bridge uses {@code stdout} as a
 * newline-delimited JSON protocol channel. {@code stdout} is redirected to {@code stderr}
 * at startup (see {@code BridgeMain}), and every diagnostic path in the bridge routes
 * through this class, so no log statement can ever interleave with a protocol frame.
 */
public final class Log {

    public enum Level {
        ERROR, WARN, INFO, DEBUG, TRACE;

        public static Level parse(String text) {
            if (text == null) {
                return INFO;
            }
            switch (text.trim().toLowerCase(java.util.Locale.ROOT)) {
                case "error":
                    return ERROR;
                case "warn":
                case "warning":
                    return WARN;
                case "debug":
                    return DEBUG;
                case "trace":
                    return TRACE;
                case "info":
                default:
                    return INFO;
            }
        }
    }

    private static final DateTimeFormatter TIMESTAMP = DateTimeFormatter.ofPattern("HH:mm:ss.SSS");

    private static volatile Level threshold = Level.INFO;

    private Log() {
    }

    /**
     * Resolves the sink lazily so that {@code BridgeMain} can install a UTF-8
     * {@code System.err} before the first line is written.
     */
    private static PrintStream sink() {
        return System.err;
    }

    public static void init(Level level) {
        threshold = level == null ? Level.INFO : level;
    }

    public static Level level() {
        return threshold;
    }

    public static boolean isEnabled(Level level) {
        return level.ordinal() <= threshold.ordinal();
    }

    public static void error(String format, Object... args) {
        write(Level.ERROR, format, args);
    }

    public static void warn(String format, Object... args) {
        write(Level.WARN, format, args);
    }

    public static void info(String format, Object... args) {
        write(Level.INFO, format, args);
    }

    public static void debug(String format, Object... args) {
        write(Level.DEBUG, format, args);
    }

    public static void trace(String format, Object... args) {
        write(Level.TRACE, format, args);
    }

    /** Logs an unexpected failure together with its stack trace. */
    public static void error(String message, Throwable failure) {
        error("%s: %s", message, failure);
        if (isEnabled(Level.DEBUG)) {
            failure.printStackTrace(sink());
            sink().flush();
        }
    }

    private static void write(Level level, String format, Object... args) {
        if (!isEnabled(level)) {
            return;
        }
        String rendered = args == null || args.length == 0
                ? format
                : String.format(format, args);
        sink().println(TIMESTAMP.format(LocalTime.now()) + " " + level + " " + rendered);
    }
}
