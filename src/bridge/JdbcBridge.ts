import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';

import { Config } from '../constants';
import { describeError, log } from '../util/logger';
import { locateJava } from './JavaLocator';
import { Events, Methods } from './protocol';
import { BridgeStoppedError, RpcChannel, type RpcEventFrame } from './RpcChannel';

export type BridgeState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';

/**
 * JVM modules opened to driver code.
 *
 * Plenty of JDBC drivers reach into JDK internals by reflection - to read a char array's backing
 * store, to unpick a `ByteBuffer`, to poke at date formatting. Those accesses were legal before
 * Java 9 and are refused by default on Java 17 and later, so drivers that have not been updated
 * fail with `InaccessibleObjectException` at the worst possible moment.
 *
 * Only modules and packages that exist in Java 17 are listed. An `--add-opens` naming something
 * absent is not always harmless: the specification allows a JVM to treat it as fatal, and a bridge
 * that refuses to start is a worse failure than a driver warning. Every entry here was verified to
 * be accepted on a current JDK.
 */
const ADD_OPENS = [
  'java.base/java.lang',
  'java.base/java.lang.reflect',
  'java.base/java.util',
  'java.base/java.text',
  'java.base/java.math',
  'java.base/java.io',
  'java.base/java.net',
  'java.base/java.nio',
  'java.base/sun.nio.ch',
].map((moduleAndPackage) => `--add-opens=${moduleAndPackage}=ALL-UNNAMED`);

/** How long to wait for the bridge to announce itself before giving up. */
const READY_TIMEOUT_MS = 20_000;

/** How long a graceful `system.shutdown` gets before the process is terminated. */
const SHUTDOWN_GRACE_MS = 3_000;

/** Auto-restart attempts allowed after an unexpected exit. */
const MAX_AUTO_RESTARTS = 3;

/** Base delay between automatic restarts; multiplied by the attempt number. */
const AUTO_RESTART_DELAY_MS = 500;

/** How many stderr lines to retain for failure messages. */
const STDERR_TAIL_LIMIT = 40;

/**
 * Owns the bridge child process.
 *
 * The process is started lazily on first use and kept alive for the session, because a JDBC driver
 * costs real time to load and pooled connections only help if the JVM outlives individual requests.
 */
export class JdbcBridge implements vscode.Disposable {
  private child: ChildProcessWithoutNullStreams | undefined;
  private channel: RpcChannel | undefined;
  private state: BridgeState = 'stopped';
  private startPromise: Promise<void> | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private autoRestarts = 0;
  private intentionalStop = false;
  private disposed = false;

  private stderrBuffer = '';
  private readonly stderrTail: string[] = [];
  private readonly listeners = new Set<(event: RpcEventFrame) => void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly stateEmitter = new vscode.EventEmitter<BridgeState>();

  /** Fires whenever the process moves between states, so the UI can react. */
  readonly onDidChangeState = this.stateEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get currentState(): BridgeState {
    return this.state;
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  /** Subscribes to events pushed by the bridge, such as progress and health updates. */
  onEvent(listener: (event: RpcEventFrame) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  /**
   * Starts the bridge if it is not already running.
   *
   * Concurrent callers share one start attempt; without that, several features activating at once
   * would race to spawn competing processes.
   */
  async ensureStarted(): Promise<void> {
    if (this.state === 'ready' && this.child) {
      return;
    }
    if (this.disposed) {
      throw new BridgeStoppedError('The extension is shutting down.');
    }
    this.startPromise ??= this.start().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  /** Sends a request, starting the bridge first if necessary. */
  async request<T>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    await this.ensureStarted();
    const channel = this.channel;
    if (!channel) {
      throw new BridgeStoppedError();
    }
    return channel.request<T>(method, params, options);
  }

  /** Stops and starts the bridge, which also drops every open connection. */
  async restart(): Promise<void> {
    await this.stop();
    this.disposed = false;
    this.intentionalStop = false;
    this.autoRestarts = 0;
    await this.ensureStarted();
  }

  /**
   * Stops the bridge, asking it to shut down gracefully first.
   *
   * A graceful stop matters: the bridge closes pooled connections on the way out, and a database
   * that sees connections vanish instead may take a while to notice, holding server-side resources
   * in the meantime.
   */
  async stop(): Promise<void> {
    this.intentionalStop = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }

    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.teardownProcess();
      this.setState('stopped');
      return;
    }

    this.setState('stopping');
    log.info('Stopping the JDBC bridge');

    try {
      child.stdin.write(`${JSON.stringify({ id: 'shutdown', method: Methods.shutdown, params: {} })}\n`);
    } catch {
      // The pipe may already be broken; the termination below handles that case.
    }

    if (!(await waitForExit(child, SHUTDOWN_GRACE_MS))) {
      log.debug('The JDBC bridge did not exit in time; terminating it');
      child.kill();
      await waitForExit(child, 2_000);
    }

    this.teardownProcess();
    this.setState('stopped');
  }

  dispose(): void {
    this.disposed = true;
    // Deactivation cannot wait, so the graceful stop runs detached. `deactivate` awaits `stop()`
    // explicitly when it has the opportunity.
    void this.stop();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.listeners.clear();
    this.stateEmitter.dispose();
  }

  // ------------------------------------------------------------------
  // process management
  // ------------------------------------------------------------------

  private async start(): Promise<void> {
    this.setState('starting');
    this.intentionalStop = false;

    const jarPath = this.resolveBridgeJar();
    const java = await locateJava();
    const args = this.buildArgs(jarPath);

    log.info(`Starting the JDBC bridge with ${java.executable}`);
    log.debug(`Bridge arguments: ${args.join(' ')}`);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(java.executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      this.setState('failed');
      throw new Error(`Could not start Java at '${java.executable}': ${describeError(error)}`);
    }

    this.child = child;
    this.stderrBuffer = '';
    this.stderrTail.length = 0;

    const channel = new RpcChannel((line) => this.writeLine(line));
    this.channel = channel;
    this.subscriptions.push(
      channel.onEvent((event) => {
        // Mirror bridge stderr into the log so a user sees driver chatter in context, not only
        // when a request happens to fail.
        if (event.method === Events.log) {
          log.debug(`[bridge] ${JSON.stringify(event.params ?? {})}`);
        }
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch (error) {
            log.error(error, `A listener for bridge event '${event.method}' threw`);
          }
        }
      }),
    );

    child.stdout.on('data', (chunk: Buffer) => channel.accept(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk));
    child.on('error', (error) => this.onProcessError(error));
    child.on('exit', (code, signal) => this.onProcessExit(code, signal));

    try {
      await this.waitForReady(child, channel);
    } catch (error) {
      // Leave nothing half-alive: a process that failed its handshake is not usable.
      await this.stop();
      this.setState('failed');
      throw error;
    }

    this.autoRestarts = 0;
    this.setState('ready');
  }

  private waitForReady(child: ChildProcessWithoutNullStreams, channel: RpcChannel): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let subscription: vscode.Disposable | undefined;

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        subscription?.dispose();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      timer = setTimeout(() => {
        finish(new Error(`The JDBC bridge did not become ready within ${READY_TIMEOUT_MS} ms.${this.stderrHint()}`));
      }, READY_TIMEOUT_MS);

      subscription = channel.onEvent((event) => {
        if (event.method === Events.ready) {
          log.debug(`Bridge announced itself: ${JSON.stringify(event.params ?? {})}`);
          finish();
        }
      });

      child.once('exit', (code) => {
        finish(
          new Error(
            `The JDBC bridge exited with code ${code ?? 'null'} before it was ready.${this.stderrHint()}`,
          ),
        );
      });
    });
  }

  private onProcessError(error: Error): void {
    log.error(error, 'The JDBC bridge process reported an error');
  }

  private onProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasReady = this.state === 'ready';
    const wasIntentional = this.intentionalStop;

    this.teardownProcess();
    if (this.disposed) {
      return;
    }

    if (wasIntentional) {
      this.setState('stopped');
      return;
    }

    const summary = `code ${code ?? 'null'}, signal ${signal ?? 'none'}`;
    log.warn(`The JDBC bridge exited unexpectedly (${summary}).${this.stderrHint()}`);

    // Only restart a process that had been working. A bridge that dies during startup - a bad jar,
    // an incompatible driver - would otherwise be relaunched in a loop.
    if (wasReady && this.autoRestarts < MAX_AUTO_RESTARTS) {
      this.autoRestarts++;
      const delay = AUTO_RESTART_DELAY_MS * this.autoRestarts;
      log.info(`Restarting the JDBC bridge in ${delay} ms (attempt ${this.autoRestarts} of ${MAX_AUTO_RESTARTS}).`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        void this.ensureStarted().catch((error: unknown) => {
          log.error(error, 'The automatic restart of the JDBC bridge failed');
          this.setState('failed');
        });
      }, delay);
      return;
    }

    this.setState('failed');
  }

  private teardownProcess(): void {
    this.channel?.dispose(new BridgeStoppedError('The JDBC bridge stopped.'));
    this.channel = undefined;

    const child = this.child;
    this.child = undefined;
    if (child) {
      child.removeAllListeners();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    this.stderrBuffer = '';
  }

  private writeLine(line: string): void {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      throw new BridgeStoppedError();
    }
    child.stdin.write(`${line}\n`);
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString('utf8');
    let newline = this.stderrBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stderrBuffer.slice(0, newline).replace(/\r$/, '');
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      this.recordStderrLine(line);
      newline = this.stderrBuffer.indexOf('\n');
    }
  }

  /**
   * Routes a bridge stderr line to the matching log level.
   *
   * The bridge prefixes each line with `HH:mm:ss.SSS LEVEL `, so its own diagnostics arrive with the
   * right severity. Anything without that shape is raw driver output, which is kept at debug level
   * and retained in the tail for failure messages.
   */
  private recordStderrLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    this.stderrTail.push(line);
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
      this.stderrTail.shift();
    }

    const match = /^\d{2}:\d{2}:\d{2}\.\d{3}\s+([A-Z]+)\s+([\s\S]*)$/.exec(line);
    if (!match) {
      log.debug(`[stderr] ${line}`);
      return;
    }

    const [, level, message] = match;
    switch (level) {
      case 'ERROR':
        log.error(`[bridge] ${message}`);
        break;
      case 'WARN':
        log.warn(`[bridge] ${message}`);
        break;
      case 'DEBUG':
        log.debug(`[bridge] ${message}`);
        break;
      case 'TRACE':
        log.trace(`[bridge] ${message}`);
        break;
      default:
        log.info(`[bridge] ${message}`);
        break;
    }
  }

  private stderrHint(): string {
    if (this.stderrTail.length === 0) {
      return '';
    }
    const tail = this.stderrTail.slice(-8).join('\n    ');
    return `\n  Recent output from the bridge:\n    ${tail}`;
  }

  private setState(next: BridgeState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    log.debug(`Bridge state is now '${next}'`);
    this.stateEmitter.fire(next);
  }

  private resolveBridgeJar(): string {
    const jarPath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'bridge.jar').fsPath;
    if (!existsSync(jarPath)) {
      throw new Error(
        `The JDBC bridge is missing from this installation (expected at ${jarPath}). ` +
          'Reinstall the extension, or run "npm run bridge:compile" in a development checkout.',
      );
    }
    return jarPath;
  }

  private buildArgs(jarPath: string): string[] {
    const configuration = vscode.workspace.getConfiguration();
    const heap = configuration.get<string>(Config.jvmMaxHeap, '1g').trim() || '1g';
    const extraArgs = configuration.get<string[]>(Config.javaArgs, []).filter((arg) => arg.trim().length > 0);
    const logLevel = configuration.get<string>(Config.logLevel, 'info');

    return [
      `-Xmx${heap}`,

      // Force UTF-8 on every stream. On Java 17 the platform default encoding is still derived from
      // the host locale, so on a Windows machine set to a legacy codepage every non-ASCII table name
      // or value would be mangled on its way through the protocol.
      '-Dfile.encoding=UTF-8',
      '-Dsun.jnu.encoding=UTF-8',
      '-Dsun.stdout.encoding=UTF-8',
      '-Dsun.stderr.encoding=UTF-8',

      // Some drivers (Oracle's in particular) probe for a display and log loudly when they find none.
      '-Djava.awt.headless=true',

      `-Dopendbclient.logLevel=${logLevel}`,

      ...ADD_OPENS,
      ...extraArgs,

      '-jar',
      jarPath,
    ];
  }
}

/** Resolves true when the process exits within the timeout, false otherwise. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}
