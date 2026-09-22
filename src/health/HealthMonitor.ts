import * as vscode from 'vscode';

import { Config } from '../constants';
import { Events, Methods } from '../bridge/protocol';
import type { JdbcBridge } from '../bridge/JdbcBridge';
import type { HealthSnapshot } from '../bridge/protocol';
import { formatUptime } from '../bridge/protocol';
import { describeError, log } from '../util/logger';
import type { VirtualDocumentProvider } from '../util/VirtualDocuments';

/** Fraction of the heap in use above which the status bar starts warning. */
const HEAP_WARNING_PERCENT = 80;

/**
 * Health monitoring for the bridge process.
 *
 * The bridge pushes metrics on a schedule rather than being polled: the interval is then enforced by
 * the side that knows when a measurement was taken, and there is no round trip per sample. This class
 * subscribes once and does two things with what arrives - a status bar summary, and a report the user
 * can open when something looks wrong.
 *
 * On what is being measured: these figures describe the bridge and its JDBC layer, never the database.
 * Database-side counters such as buffer pool hit ratios live behind vendor-specific SQL, and reaching
 * them would mean writing exactly the dialect code this project is built to avoid. A user reading
 * "cache" here is looking at the bridge's spilled result cache.
 */
export class HealthMonitor implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private subscription: vscode.Disposable | undefined;
  private latest: HealthSnapshot | undefined;

  constructor(
    private readonly bridge: JdbcBridge,
    private readonly virtualDocuments: VirtualDocumentProvider,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.statusBar.command = 'open-dbclient.showHealth';
    this.disposables.push(this.statusBar);

    this.disposables.push(
      this.bridge.onEvent((event) => {
        if (event.method === Events.healthMetrics) {
          this.latest = event.params as unknown as HealthSnapshot;
          this.updateStatusBar();
        }
      }),
      this.bridge.onDidChangeState((state) => {
        if (state === 'ready') {
          void this.start();
        } else if (state === 'stopped' || state === 'failed') {
          this.stop();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(Config.healthEnabled) ||
          event.affectsConfiguration(Config.healthRefreshInterval) ||
          event.affectsConfiguration(Config.healthShowStatusBar)
        ) {
          void this.start();
        }
      }),
    );

    void this.start();
    this.updateStatusBar();
  }

  /** Begins or stops the subscription to match the current settings. */
  async start(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration();
    const enabled = configuration.get<boolean>(Config.healthEnabled, true);

    this.stop();
    this.updateStatusBar();

    if (!enabled) {
      return;
    }

    const intervalMillis = configuration.get<number>(Config.healthRefreshInterval, 2_000);
    try {
      await this.bridge.request(Methods.healthSubscribe, { intervalMillis });
      log.debug(`Subscribed to health metrics every ${intervalMillis} ms`);
    } catch (error) {
      // Health is a convenience; failing to subscribe must not surface as an error dialog.
      log.debug(`Could not subscribe to health metrics: ${describeError(error)}`);
    }
  }

  stop(): void {
    this.subscription?.dispose();
    this.subscription = undefined;
    this.latest = undefined;
    void this.bridge.request(Methods.healthUnsubscribe).catch(() => {
      // The bridge may not be running; nothing to unsubscribe from in that case.
    });
  }

  /** Opens a report in an editor, fetching a fresh snapshot when the push has not delivered one yet. */
  async showReport(): Promise<void> {
    let snapshot = this.latest;
    if (!snapshot) {
      try {
        snapshot = await this.bridge.request<HealthSnapshot>(Methods.healthSnapshot);
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not read bridge health: ${describeError(error)}`);
        return;
      }
    }

    await this.virtualDocuments.show('jdbc-bridge-health', 'md', renderReport(snapshot));
  }

  dispose(): void {
    this.stop();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private updateStatusBar(): void {
    const show = vscode.workspace.getConfiguration().get<boolean>(Config.healthShowStatusBar, true);
    if (!show || !this.latest) {
      this.statusBar.hide();
      return;
    }

    const { memory, connectionCount, queries } = this.latest;
    const heap = Math.round(memory.heapUsedPercent);
    const warn = heap >= HEAP_WARNING_PERCENT;

    this.statusBar.text = `$(pulse) ${heap}% heap · ${connectionCount} conn`;
    if (queries.running > 0) {
      this.statusBar.text += ` · ${queries.running} running`;
    }
    this.statusBar.color = warn
      ? new vscode.ThemeColor('statusBarItem.warningForeground')
      : undefined;
    this.statusBar.backgroundColor = warn
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.statusBar.tooltip = new vscode.MarkdownString(renderTooltip(this.latest));
    this.statusBar.show();
  }
}

function renderTooltip(snapshot: HealthSnapshot): string {
  const { memory, garbageCollector, threads, cache, queries } = snapshot;
  return [
    `**JDBC bridge** — up ${formatUptime(snapshot.uptimeMillis)}`,
    '',
    `Heap: ${formatBytes(memory.heapUsed)} of ${formatBytes(memory.heapMax)} (${memory.heapUsedPercent.toFixed(1)}%)`,
    `Metaspace: ${formatBytes(memory.metaspaceUsed)}`,
    `GC: ${garbageCollector.collections} run(s), ${garbageCollector.collectionTimePercent.toFixed(1)}% of uptime`,
    `Threads: ${threads.count} (peak ${threads.peak})`,
    `Result cache: ${formatBytes(cache.cachedBytes)} in ${cache.storedResults} result(s)`,
    `Queries: ${queries.completed} done, ${queries.failed} failed`,
    '',
    '_Click for the full report._',
  ].join('\n');
}

/**
 * Renders a Markdown report.
 *
 * Markdown rather than a bespoke webview because every action a user wants on a report - select,
 * search, copy, compare two of them - already works in an editor.
 */
function renderReport(snapshot: HealthSnapshot): string {
  const { memory, garbageCollector, threads, server, cache, queries, poolSummaries } = snapshot;

  const lines: string[] = [
    '# JDBC bridge health',
    '',
    `Captured ${new Date(snapshot.timestamp).toLocaleString()} · up ${formatUptime(snapshot.uptimeMillis)}`,
    '',
    '> These figures describe the bridge process and its JDBC layer only. Database-side counters are',
    '> not included, because reaching them would require vendor-specific SQL.',
    '',
    '## Memory',
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Heap used | ${formatBytes(memory.heapUsed)} |`,
    `| Heap committed | ${formatBytes(memory.heapCommitted)} |`,
    `| Heap maximum | ${formatBytes(memory.heapMax)} |`,
    `| Heap used | ${memory.heapUsedPercent.toFixed(1)}% |`,
    `| Non-heap used | ${formatBytes(memory.nonHeapUsed)} |`,
    `| Metaspace | ${formatBytes(memory.metaspaceUsed)} |`,
    '',
    '## Garbage collection',
    '',
    `Collections: **${garbageCollector.collections}** · total time: **${garbageCollector.collectionTimeMillis} ms** ` +
      `(**${garbageCollector.collectionTimePercent.toFixed(1)}%** of uptime)`,
    '',
    '| Collector | Collections | Time (ms) |',
    '| --- | ---: | ---: |',
    ...garbageCollector.collectors.map(
      (collector) => `| ${collector.name} | ${collector.collections} | ${collector.collectionTimeMillis} |`,
    ),
    '',
    '## Threads',
    '',
    `Current **${threads.count}** · peak **${threads.peak}** · daemon **${threads.daemon}**`,
    '',
    '## Protocol',
    '',
    `Handled **${server.requestsHandled}** · failed **${server.requestFailures}** · in flight **${server.activeRequests}** · handlers **${server.handlers}**`,
    '',
    '## Connections',
    '',
  ];

  if (poolSummaries.length === 0) {
    lines.push('_No connections are open._', '');
  } else {
    lines.push(
      '| Connection | Active | Idle | Total | Max | Waiting | Timeouts | Avg wait (ms) |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...poolSummaries.map(
        (pool) =>
          `| ${pool.connectionId} | ${pool.active} | ${pool.idle} | ${pool.total} | ${pool.maxSize} | ` +
          `${pool.waiting} | ${pool.borrowTimeouts} | ${pool.averageBorrowWaitMillis.toFixed(1)} |`,
      ),
      '',
    );
  }

  lines.push(
    '## Result cache',
    '',
    `**${cache.storedResults}** result(s) holding **${formatBytes(cache.cachedBytes)}** of a ${formatBytes(cache.maxCacheBytes)} budget.`,
    'Least-recently-used results are discarded when the budget is exceeded.',
    '',
  );

  if (cache.results.length > 0) {
    lines.push(
      '| Query | Connection | Rows | Size | Columns | Age | Idle |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
      ...cache.results.map(
        (result) =>
          `| ${result.queryId} | ${result.connectionId ?? '-'} | ${result.rows.toLocaleString()} | ` +
          `${formatBytes(result.bytes)} | ${result.columns} | ${formatUptime(Math.round(result.ageMillis / 1000))} | ` +
          `${formatUptime(Math.round(result.idleMillis / 1000))} |`,
      ),
      '',
    );
  }

  lines.push(
    '## Queries',
    '',
    `Running **${queries.running}** · completed **${queries.completed}** · failed **${queries.failed}** · cancelled **${queries.cancelled}**`,
    '',
    `Average duration **${queries.averageMillis} ms** · slowest **${queries.slowestMillis} ms**`,
    '',
  );

  if (queries.slowestQuery) {
    lines.push('Slowest statement:', '', '```sql', queries.slowestQuery, '```', '');
  }

  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
