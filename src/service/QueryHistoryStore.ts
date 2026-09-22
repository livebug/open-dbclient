import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';

import { describeError, log } from '../util/logger';

const HISTORY_FILE = 'query-history.jsonl';
const MAX_ENTRIES = 500;

/** One executed statement. */
export interface QueryHistoryEntry {
  readonly id: string;
  readonly sql: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly executedAt: number;
  readonly elapsedMillis: number;
  readonly succeeded: boolean;
  readonly rowCount?: number;
  readonly errorMessage?: string;
}

/**
 * Remembers executed statements.
 *
 * Stored as JSON Lines rather than a JSON array, which matters because history is written far more
 * often than it is read. Appending a line is a single write, so a crash mid-save can only ever lose
 * the entry being written; rewriting an array risks truncating the whole file at exactly the moment
 * the user is least willing to lose it.
 *
 * History is capped and trimmed on load, so the file cannot grow without bound.
 */
export class QueryHistoryStore implements vscode.Disposable {
  private entries: QueryHistoryEntry[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  private sequence = 0;

  /** Fires after any change, so the history view can repaint. */
  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Reads existing history from disk. Safe to call more than once. */
  async load(): Promise<void> {
    try {
      const text = await readFile(this.storagePath(), 'utf8');
      const parsed: QueryHistoryEntry[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) {
          continue;
        }
        try {
          const entry = JSON.parse(line) as QueryHistoryEntry;
          if (entry && typeof entry.sql === 'string') {
            parsed.push(entry);
          }
        } catch {
          // A truncated final line is the expected outcome of a crash; skipping it is the whole
          // reason for the format.
        }
      }
      // Newest first, since that is the order a user wants to see.
      this.entries = parsed.slice(-MAX_ENTRIES).reverse();
      this.sequence = parsed.length;
      this.emitter.fire();
      log.debug(`Loaded ${this.entries.length} history entr(ies)`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = [];
        return;
      }
      log.warn(`Query history could not be read: ${describeError(error)}`);
      this.entries = [];
    }
  }

  list(): readonly QueryHistoryEntry[] {
    return this.entries;
  }

  find(id: string): QueryHistoryEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  /**
   * Records a statement.
   *
   * Writing is deliberately not awaited by callers: a failure to record history must never affect the
   * query the user actually ran, and the entry is already visible in memory.
   */
  record(entry: Omit<QueryHistoryEntry, 'id' | 'executedAt'>): void {
    const full: QueryHistoryEntry = {
      ...entry,
      id: `h${++this.sequence}`,
      executedAt: Date.now(),
    };
    this.entries.unshift(full);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }
    this.emitter.fire();
    void this.append(full);
  }

  async remove(id: string): Promise<void> {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length !== before) {
      this.emitter.fire();
      await this.compact();
    }
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.emitter.fire();
    try {
      await writeFile(this.storagePath(), '', 'utf8');
    } catch (error) {
      log.warn(`Clearing query history failed: ${describeError(error)}`);
    }
  }

  storagePath(): string {
    return join(this.context.globalStorageUri.fsPath, HISTORY_FILE);
  }

  private async append(entry: QueryHistoryEntry): Promise<void> {
    try {
      const file = this.storagePath();
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      log.debug(`Recording query history failed: ${describeError(error)}`);
    }
  }

  /** Rewrites the file so a deletion actually shrinks it. */
  private async compact(): Promise<void> {
    try {
      const lines = [...this.entries].reverse().map((entry) => JSON.stringify(entry));
      await writeFile(this.storagePath(), lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
    } catch (error) {
      log.warn(`Compacting query history failed: ${describeError(error)}`);
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
