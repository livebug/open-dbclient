package com.opendbclient.bridge.rpc;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Request counters shared across every connection served by one bridge process.
 *
 * <p>In stdio mode there is exactly one connection, so sharing is a no-op. In {@code --listen}
 * mode the bridge serves many connections at once, and these figures describe the whole process
 * rather than any single channel: {@code requestsHandled}, {@code requestFailures} and {@code
 * activeRequests} are the totals a health panel shows, and {@code uptimeMillis} starts when the
 * process starts, not when a particular connection was accepted.
 *
 * <p>The counters are mutated on the hot path, so they are atomic rather than synchronised.
 */
public final class ServerMetrics {

    private final AtomicLong requestsHandled = new AtomicLong();
    private final AtomicLong requestFailures = new AtomicLong();
    private final AtomicInteger activeRequests = new AtomicInteger();
    private final long startedAtNanos = System.nanoTime();

    /** How many handlers each connection registers; set once by {@code BridgeServices}. */
    private volatile int handlerCount;

    public void recordHandled() {
        requestsHandled.incrementAndGet();
    }

    public void recordFailure() {
        requestFailures.incrementAndGet();
    }

    public void addActive() {
        activeRequests.incrementAndGet();
    }

    public void removeActive() {
        activeRequests.decrementAndGet();
    }

    public long requestsHandled() {
        return requestsHandled.get();
    }

    public long requestFailures() {
        return requestFailures.get();
    }

    public int activeRequestCount() {
        return activeRequests.get();
    }

    public long uptimeMillis() {
        return (System.nanoTime() - startedAtNanos) / 1_000_000L;
    }

    public int handlerCount() {
        return handlerCount;
    }

    public void setHandlerCount(int handlerCount) {
        this.handlerCount = handlerCount;
    }
}
