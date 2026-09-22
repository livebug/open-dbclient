package com.opendbclient.bridge.pool;

import java.util.Map;

import com.opendbclient.bridge.json.Json;

/**
 * Immutable snapshot of a connection pool, used for health reporting.
 *
 * <p>The counters exist independently of the health panel: they are the only way to tell a pool
 * that is idle from one that is saturated, and to distinguish "connections are slow to create"
 * from "callers are not returning them".
 *
 * @param profileId            pool this snapshot describes
 * @param maxSize              configured ceiling on physical connections
 * @param total                physical connections currently open (idle + checked out)
 * @param active               connections currently checked out
 * @param idle                 connections parked and available
 * @param waiting              callers blocked in {@code borrow}
 * @param created              successful connection creations, cumulative
 * @param destroyed            connections closed, cumulative
 * @param borrowed             successful borrows, cumulative
 * @param borrowTimeouts       borrows that gave up waiting, cumulative
 * @param validationFailures   liveness probes that rejected a connection, cumulative
 * @param connectFailures      attempts to create a physical connection that threw, cumulative
 * @param totalBorrowWaitMillis aggregate time callers spent waiting for a connection
 * @param maxBorrowWaitMillis  longest single wait observed
 * @param closed               pool has been shut down
 */
public record PoolStats(
        String profileId,
        int maxSize,
        int total,
        int active,
        int idle,
        int waiting,
        long created,
        long destroyed,
        long borrowed,
        long borrowTimeouts,
        long validationFailures,
        long connectFailures,
        long totalBorrowWaitMillis,
        long maxBorrowWaitMillis,
        boolean closed) {

    /** Mean time a caller waited for a connection, in milliseconds. */
    public double averageBorrowWaitMillis() {
        return borrowed == 0 ? 0.0 : (double) totalBorrowWaitMillis / borrowed;
    }

    /** Fraction of the pool ceiling currently in use, between 0 and 1. */
    public double utilisation() {
        return maxSize <= 0 ? 0.0 : (double) total / maxSize;
    }

    public Map<String, Object> toPayload() {
        return Json.obj(
                "profileId", profileId,
                "maxSize", maxSize,
                "total", total,
                "active", active,
                "idle", idle,
                "waiting", waiting,
                "created", created,
                "destroyed", destroyed,
                "borrowed", borrowed,
                "borrowTimeouts", borrowTimeouts,
                "validationFailures", validationFailures,
                "connectFailures", connectFailures,
                "totalBorrowWaitMillis", totalBorrowWaitMillis,
                "maxBorrowWaitMillis", maxBorrowWaitMillis,
                "averageBorrowWaitMillis", averageBorrowWaitMillis(),
                "utilisation", utilisation(),
                "closed", closed);
    }
}
