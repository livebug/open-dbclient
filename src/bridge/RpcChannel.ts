import type { Disposable } from 'vscode';

import { log } from '../util/logger';
import { NdjsonFramer } from './NdjsonFramer';

/**
 * Request/response correlation over an NDJSON stream.
 *
 * The channel owns no transport: the caller supplies a way to write a line and feeds inbound bytes
 * to {@link accept}. That keeps process management, restart policy and stream ownership in
 * {@link import('./JdbcBridge').JdbcBridge}, where they can be reasoned about as a whole.
 */
export class RpcChannel implements Disposable {
  private readonly framer: NdjsonFramer;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: RpcEventFrame) => void>();
  private counter = 0;
  private disposed = false;

  constructor(
    private readonly writeLine: (line: string) => void,
    /** Applied when a request does not specify its own timeout. Zero disables timing out. */
    private readonly defaultTimeoutMs: number = 30_000,
  ) {
    this.framer = new NdjsonFramer(
      (value) => this.handleFrame(value),
      (raw, error) => {
        // Never rethrown: one bad line must not stop the remaining frames from being processed.
        log.warn(`Ignoring an unparseable frame from the JDBC bridge: ${describe(error)} (${truncate(raw)})`);
      },
    );
  }

  /** Subscribe to unsolicited frames such as progress and health pushes. */
  onEvent(listener: (event: RpcEventFrame) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Feeds bytes received from the bridge's stdout. */
  accept(chunk: Uint8Array): void {
    this.framer.push(chunk);
  }

  /** Sends a request and resolves with its result. */
  request<T>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new BridgeStoppedError());
    }

    const id = String(++this.counter);
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          // A timed-out request is still running in the bridge. The caller keeps the id it needs to
          // cancel it, which is why this only fails the promise rather than tearing anything down.
          reject(new RpcError(
            'TIMEOUT',
            `Timed out after ${timeoutMs} ms waiting for '${method}' to finish. The request may still be running.`,
          ));
        }, timeoutMs);
      }

      this.pending.set(id, pending);
      try {
        this.writeLine(JSON.stringify({ id, method, params: params ?? {} }));
      } catch (error) {
        this.settle(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Number of requests awaiting a response. */
  get inFlight(): number {
    return this.pending.size;
  }

  /**
   * Fails every outstanding request.
   *
   * Called when the bridge process dies. Leaving the promises pending would hang the caller forever,
   * and a hang is much harder to diagnose than an explicit "the bridge exited".
   */
  dispose(reason: Error = new BridgeStoppedError()): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.framer.reset();

    const outstanding = [...this.pending.values()];
    this.pending.clear();
    for (const pending of outstanding) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      if (pending.method !== 'system.shutdown') {
        log.debug(`Abandoning request '${pending.method}': ${reason.message}`);
      }
      pending.reject(reason);
    }

    this.listeners.clear();
  }

  private settle(id: string): void {
    const pending = this.pending.get(id);
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(id);
  }

  private handleFrame(value: unknown): void {
    if (!isRecord(value)) {
      log.warn('Ignoring a bridge frame that is not a JSON object');
      return;
    }

    if (value.type === 'event') {
      const event = value as unknown as RpcEventFrame;
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (error) {
          log.error(error, `A handler for bridge event '${event.method}' threw`);
        }
      }
      return;
    }

    const id = value.id;
    if (typeof id !== 'string') {
      log.warn('Ignoring a bridge frame with no request id');
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) {
      // Expected for a request abandoned by a timeout.
      log.debug(`Received a response for unknown request id '${id}'`);
      return;
    }
    this.settle(id);

    if (value.ok === true) {
      pending.resolve(value.result);
      return;
    }
    if (value.ok === false) {
      pending.reject(toRpcError(value.error));
      return;
    }
    pending.reject(new RpcError('MALFORMED', 'The bridge sent a response with no ok field'));
  }
}

/** A frame pushed by the bridge without a matching request. */
export interface RpcEventFrame {
  readonly type: 'event';
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** A structured failure reported by the bridge. Mirrors `RpcException` on the Java side. */
export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly sqlState?: string,
    readonly vendorErrorCode?: number,
  ) {
    super(message);
    this.name = 'RpcError';
  }

  /** True when the request was at fault rather than the database or the bridge. */
  get isCallerError(): boolean {
    return this.code === 'INVALID_PARAMS' || this.code === 'UNKNOWN_METHOD';
  }

  /** True when the request was understood but the operation did not succeed. */
  get isDatabaseError(): boolean {
    return this.code === 'SQL_ERROR';
  }
}

/** Raised when a request cannot be sent because the bridge is not running. */
export class BridgeStoppedError extends Error {
  constructor(message = 'The JDBC bridge is not running.') {
    super(message);
    this.name = 'BridgeStoppedError';
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRpcError(payload: unknown): RpcError {
  if (!isRecord(payload)) {
    return new RpcError('MALFORMED', 'The bridge reported a failure without any detail');
  }
  const code = typeof payload.code === 'string' ? payload.code : 'UNKNOWN';
  const message = typeof payload.message === 'string' ? payload.message : 'The bridge reported a failure';
  const sqlState = typeof payload.sqlState === 'string' ? payload.sqlState : undefined;
  const vendorErrorCode = typeof payload.errorCode === 'number' ? payload.errorCode : undefined;
  return new RpcError(code, message, sqlState, vendorErrorCode);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, limit = 200): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}
