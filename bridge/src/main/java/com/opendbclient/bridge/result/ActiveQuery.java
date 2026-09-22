package com.opendbclient.bridge.result;

import java.sql.SQLException;
import java.sql.Statement;
import java.util.concurrent.atomic.AtomicBoolean;

import com.opendbclient.bridge.log.Log;
import com.opendbclient.bridge.rpc.RequestContext;

/**
 * A query that is currently executing.
 *
 * <h2>Cancellation has two mechanisms, and both are needed</h2>
 *
 * {@link Statement#cancel()} exists precisely for this: the JDBC specification states it may be
 * called from one thread to abort a statement running on another. It is the only way to stop a
 * database that is busy computing, because no amount of cooperation on our side can interrupt a
 * server that is not looking. It is invoked first.
 *
 * <p>It is not sufficient on its own. Some drivers implement {@code cancel()} by reaching for the
 * connection, which can block behind the very statement being cancelled; others ignore it entirely.
 * So a flag is also set on the {@link RequestContext}, which the row-reading loop polls. Whichever
 * mechanism the driver supports, the query stops, and a query already returning rows stops promptly
 * rather than streaming a result nobody is waiting for.
 */
public final class ActiveQuery {

    private final String queryId;
    private final String connectionId;
    private final RequestContext context;
    private final AtomicBoolean cancelled = new AtomicBoolean(false);
    private final long startedAtMillis;

    private volatile Statement statement;

    public ActiveQuery(String queryId, String connectionId, RequestContext context) {
        this.queryId = queryId;
        this.connectionId = connectionId;
        this.context = context;
        this.startedAtMillis = System.currentTimeMillis();
    }

    public String queryId() {
        return queryId;
    }

    public String connectionId() {
        return connectionId;
    }

    public long startedAtMillis() {
        return startedAtMillis;
    }

    public long elapsedMillis() {
        return System.currentTimeMillis() - startedAtMillis;
    }

    /** Associates the statement so it can be cancelled. Called before execution begins. */
    public void attach(Statement statement) {
        this.statement = statement;
        if (cancelled.get()) {
            // Cancelled in the window between registration and execution; stop it now.
            cancelStatement(statement);
        }
    }

    public void detach() {
        this.statement = null;
    }

    public boolean isCancelled() {
        return cancelled.get() || context.isCancelled();
    }

    /**
     * Requests cancellation. Safe to call from any thread, including while the query is running.
     *
     * @return {@code true} if this call was the one that initiated the cancellation
     */
    public boolean cancel() {
        if (!cancelled.compareAndSet(false, true)) {
            return false;
        }
        context.markCancelled();

        Statement current = this.statement;
        if (current != null) {
            cancelStatement(current);
        }
        return true;
    }

    /** Reports progress to the extension, so a long query can show movement rather than a spinner. */
    public void progress(long rowsRead) {
        context.progress(rowsRead, null);
    }

    private static void cancelStatement(Statement statement) {
        try {
            statement.cancel();
            Log.debug("Requested cancellation of a running statement");
        } catch (SQLException | RuntimeException failure) {
            // Not every driver supports this, and some throw when called on a completed statement.
            // The cooperative flag still stops the read loop, so this is not fatal.
            Log.debug("Statement.cancel() was refused by the driver: %s", failure.getMessage());
        }
    }
}
