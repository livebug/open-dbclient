/**
 * Splits a byte stream into newline-delimited JSON frames.
 *
 * Kept separate from the RPC channel because it is pure logic with no VS Code or child-process
 * dependency, and because the two things it has to get right are easy to get subtly wrong:
 *
 * 1. **Chunk boundaries do not respect lines or characters.** A chunk can end anywhere, including
 *    in the middle of a UTF-8 sequence. Decoding each chunk independently would turn a CJK table
 *    name into replacement characters the moment it straddles a boundary, so a streaming
 *    {@link TextDecoder} is used and the decode result is concatenated rather than emitted.
 *
 * 2. **A malformed frame must not poison the stream.** Driver output that slips onto stdout, or a
 *    partial write, would otherwise throw out of the read handler and abort handling for every
 *    frame after it. Failures are reported and skipped.
 */
export class NdjsonFramer {
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';

  constructor(
    private readonly onFrame: (value: unknown, raw: string) => void,
    private readonly onMalformed: (raw: string, error: unknown) => void,
  ) {}

  /** Feeds raw bytes, emitting each complete frame that becomes available. */
  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });

    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      if (line.trim().length > 0) {
        this.deliver(line);
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  /**
   * Drops any partial frame.
   *
   * Called when the underlying stream is replaced - after a bridge restart the leftover bytes belong
   * to a process that no longer exists, and combining them with the new stream would fabricate a
   * frame neither process wrote.
   */
  reset(): void {
    this.buffer = '';
    this.decoder.decode();
  }

  /** Length of the incomplete trailing frame, useful when diagnosing a hang. */
  get pendingLength(): number {
    return this.buffer.length;
  }

  private deliver(line: string): void {
    try {
      this.onFrame(JSON.parse(line), line);
    } catch (error) {
      this.onMalformed(line, error);
    }
  }
}
