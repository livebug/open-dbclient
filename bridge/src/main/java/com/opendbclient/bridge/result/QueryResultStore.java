package com.opendbclient.bridge.result;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;

import com.opendbclient.bridge.json.Json;
import com.opendbclient.bridge.log.Log;

/**
 * Stores one query's rows on disk and serves pages from them.
 *
 * <h2>Why results do not stay in memory</h2>
 *
 * A {@code SELECT} against a real table routinely returns more than fits comfortably in the bridge's
 * heap, and the extension only ever displays a screenful at a time. Holding every row in memory to
 * serve a page of two hundred would trade a bounded cost for an unbounded one.
 *
 * <h2>Why paging does not scan from the start</h2>
 *
 * The naive spill-and-scan design makes page <em>n</em> cost O(n): reaching the last page of a
 * million-row result reads the whole file. A checkpoint is recorded every
 * {@value #CHECKPOINT_INTERVAL} rows holding the byte offset of that row, so a page seek costs one
 * file position plus at most {@value #CHECKPOINT_INTERVAL} line reads. For a million rows the index
 * is under four thousand entries - a few tens of kilobytes to make every page equally cheap.
 *
 * <h2>Format</h2>
 *
 * One JSON array per line, UTF-8, newline-terminated. JSON Lines rather than a single array so rows
 * can be appended as they arrive and read back without parsing the whole document, and rather than a
 * binary format so a corrupted result can be inspected with the same tools as anything else.
 */
public final class QueryResultStore implements AutoCloseable {

    /** Rows between successive checkpoints. */
    public static final int CHECKPOINT_INTERVAL = 256;

    /** Size of the read buffer used when seeking to a checkpoint. */
    private static final int READ_BUFFER_BYTES = 64 * 1024;

    private final String queryId;
    private final Path dataFile;
    private final List<ResultColumn> columns;
    private final List<Checkpoint> checkpoints = new ArrayList<>();
    private final FileChannel channel;

    private final long createdAtMillis;
    private volatile long lastAccessedMillis;
    private long rowCount;
    private long byteCount;
    private boolean closed;

    public QueryResultStore(String queryId, List<ResultColumn> columns) throws IOException {
        this.queryId = queryId;
        this.columns = List.copyOf(columns);
        this.dataFile = Files.createTempFile("open-dbclient-", ".ndjson");
        this.channel = FileChannel.open(
                dataFile, StandardOpenOption.WRITE, StandardOpenOption.READ, StandardOpenOption.DELETE_ON_CLOSE);
        this.createdAtMillis = System.currentTimeMillis();
        this.lastAccessedMillis = createdAtMillis;
        Log.debug("Result store for '%s' created at %s", queryId, dataFile);
    }

    public String queryId() {
        return queryId;
    }

    public List<ResultColumn> columns() {
        return columns;
    }

    public long rowCount() {
        return rowCount;
    }

    public long byteCount() {
        return byteCount;
    }

    public Path dataFile() {
        return dataFile;
    }

    public boolean isClosed() {
        return closed;
    }

    /** Appends one row, recording a checkpoint when the row index calls for one. */
    public void appendRow(List<Object> values) throws IOException {
        String line = Json.write(values);
        byte[] bytes = line.getBytes(StandardCharsets.UTF_8);

        if (rowCount % CHECKPOINT_INTERVAL == 0) {
            checkpoints.add(new Checkpoint(rowCount, byteCount));
        }

        ByteBuffer buffer = ByteBuffer.wrap(bytes);
        while (buffer.hasRemaining()) {
            channel.write(buffer);
        }
        channel.write(ByteBuffer.wrap(new byte[] {'\n'}));

        byteCount += bytes.length + 1L;
        rowCount++;
    }

    /**
     * Reads a page of rows.
     *
     * @param offset zero-based index of the first row wanted
     * @param limit  maximum number of rows to return
     */
    public Page fetch(int offset, int limit) throws IOException {
        lastAccessedMillis = System.currentTimeMillis();

        int safeOffset = Math.max(0, offset);
        int safeLimit = Math.max(0, limit);
        if (safeLimit == 0 || safeOffset >= rowCount) {
            return new Page(safeOffset, List.of(), rowCount);
        }

        Checkpoint checkpoint = nearestCheckpoint(safeOffset);
        int rowsToSkip = (int) (safeOffset - checkpoint.rowIndex());

        List<String> lines = readLines(checkpoint.byteOffset(), rowsToSkip + safeLimit);

        // The first rowsToSkip lines were read only to advance the position.
        List<List<Object>> rows = new ArrayList<>(Math.min(safeLimit, Math.max(0, lines.size() - rowsToSkip)));
        for (int i = rowsToSkip; i < lines.size(); i++) {
            rows.add(parseRow(lines.get(i)));
        }

        return new Page(safeOffset, rows, rowCount);
    }

    /** Metadata describing this result. */
    public ResultMeta meta() {
        return new ResultMeta(queryId, columns, rowCount, byteCount, createdAtMillis, lastAccessedMillis);
    }

    @Override
    public void close() {
        if (closed) {
            return;
        }
        closed = true;
        try {
            channel.close();
        } catch (IOException failure) {
            Log.debug("Closing the result file for '%s' failed: %s", queryId, failure.getMessage());
        }
        try {
            Files.deleteIfExists(dataFile);
        } catch (IOException failure) {
            Log.debug("Deleting the result file %s failed: %s", dataFile, failure.getMessage());
        }
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    /**
     * Finds the newest checkpoint at or before {@code rowIndex}.
     *
     * Row zero always has a checkpoint, so this never returns null.
     */
    private Checkpoint nearestCheckpoint(int rowIndex) {
        int index = Math.min(checkpoints.size() - 1, rowIndex / CHECKPOINT_INTERVAL);
        return checkpoints.get(Math.max(0, index));
    }

    /**
     * Reads up to {@code maxLines} newline-terminated lines starting at a byte offset.
     *
     * {@link java.io.RandomAccessFile#readLine()} is not used because it decodes bytes as Latin-1,
     * which turns any UTF-8 content into mojibake - a failure that would only show up for users
     * whose data is not ASCII. Lines are split on raw bytes and decoded afterwards instead.
     */
    private List<String> readLines(long startOffset, int maxLines) throws IOException {
        List<String> lines = new ArrayList<>(Math.min(maxLines, 1024));
        ByteArrayOutputStream pending = new ByteArrayOutputStream(256);
        ByteBuffer buffer = ByteBuffer.allocate(READ_BUFFER_BYTES);
        boolean exhausted = false;

        channel.position(startOffset);
        while (lines.size() < maxLines && !exhausted) {
            buffer.clear();
            int read = channel.read(buffer);
            if (read < 0) {
                exhausted = true;
                break;
            }
            buffer.flip();
            while (buffer.hasRemaining()) {
                byte next = buffer.get();
                if (next == '\n') {
                    lines.add(pending.toString(StandardCharsets.UTF_8));
                    pending.reset();
                    if (lines.size() >= maxLines) {
                        break;
                    }
                } else {
                    pending.write(next);
                }
            }
        }

        // Every appended row ends with a newline, so a trailing fragment means the offset landed
        // mid-file unexpectedly. Reporting it is better than silently dropping a row.
        if (pending.size() > 0) {
            Log.warn("Result file for '%s' ended without a newline; the last row may be incomplete", queryId);
        }
        return lines;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> parseRow(String line) {
        Object parsed = Json.parse(line);
        if (parsed instanceof List<?> row) {
            return (List<Object>) row;
        }
        throw new IllegalStateException("a stored row is not a JSON array");
    }

    /** A row index paired with the byte offset it starts at. */
    private record Checkpoint(long rowIndex, long byteOffset) {
    }

    /**
     * A page of rows.
     *
     * @param offset   index of the first returned row
     * @param rows     the rows themselves
     * @param totalRows total rows in the stored result
     */
    public record Page(int offset, List<List<Object>> rows, long totalRows) {
    }

    /**
     * Everything known about a stored result.
     *
     * @param lastAccessedMillis used for least-recently-used eviction under memory pressure
     */
    public record ResultMeta(
            String queryId,
            List<ResultColumn> columns,
            long rowCount,
            long byteCount,
            long createdAtMillis,
            long lastAccessedMillis) {
    }
}
