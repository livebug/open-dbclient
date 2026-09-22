import * as vscode from 'vscode';

import { Config } from '../constants';
import { Methods } from '../bridge/protocol';
import type { JdbcBridge } from '../bridge/JdbcBridge';
import type {
  CellValue,
  QueryExecuteResult,
  QueryFetchResult,
  ResultColumnInfo,
} from '../bridge/protocol';
import { describeError, log } from '../util/logger';
import type { ConnectionService } from '../service/ConnectionService';
import type { ExportService } from '../service/ExportService';
import {
  DEFAULT_PAGE_SIZE,
  type GridColumn,
  type GridValue,
  type HostToWebviewMessage,
  type WebviewToHostMessage,
} from './messages';

/** What a panel needs from the rest of the extension. */
export interface ResultPanelDependencies {
  readonly extensionUri: vscode.Uri;
  readonly bridge: JdbcBridge;
  readonly connections: ConnectionService;
  readonly exportService: ExportService;
}

/** How a panel was opened, and what to do when the user asks to run it again. */
export interface ResultPanelOptions extends ResultPanelDependencies {
  /** Stable identity, so re-running from the same source reuses its panel rather than stacking them. */
  readonly key: string;
  readonly title: string;
  /** Invoked when the user presses Run again inside the panel. */
  readonly onRerun?: () => Promise<void>;
}

/**
 * A tab showing one statement's result.
 *
 * The panel keeps only the metadata for the whole result, not the rows: the bridge holds the rows in
 * its spill file and the grid pulls a page at a time. That is what lets a two-million-row result be
 * browsed without a two-million-row message ever existing.
 */
export class ResultPanel implements vscode.Disposable {
  private static readonly registry = new Map<string, ResultPanel>();

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  private columns: readonly GridColumn[] = [];
  private queryId: string | undefined;
  private sourceSql = '';
  private connectionName = '';
  private pageSize: number;
  private lastMessage: HostToWebviewMessage | undefined;

  /**
   * Finds the query a connection is currently running, if any.
   *
   * Used by the cancel command, which arrives from a keybinding or the command palette and therefore
   * has no panel reference of its own. Panel keys begin with the connection id, so the lookup is a
   * prefix match rather than a second registry that could fall out of step.
   */
  static runningQueryIdFor(connectionId: string): string | undefined {
    for (const instance of ResultPanel.registry.values()) {
      if (instance.options.key.startsWith(`${connectionId}:`) && instance.runningQueryId) {
        return instance.runningQueryId;
      }
    }
    return undefined;
  }

  private runningQueryId: string | undefined;

  /**
   * Re-runs whatever the panel is currently showing.
   *
   * Replaced every time the panel is reused. Holding on to the handler from the panel's first use
   * meant "Run again" repeated that first statement forever, which for a new query file was the
   * `SELECT 1` template rather than the query on screen.
   */
  private onRerun: (() => Promise<void>) | undefined;

  /** Opens or reveals the panel for a key. */
  static async show(options: ResultPanelOptions): Promise<ResultPanel> {
    const existing = ResultPanel.registry.get(options.key);
    if (existing && !existing.disposed) {
      existing.onRerun = options.onRerun;
      existing.panel.title = options.title;
      existing.panel.reveal(undefined, false);
      return existing;
    }

    const panel = await createPanel(options);

    const instance = new ResultPanel(panel, options);
    ResultPanel.registry.set(options.key, instance);
    return instance;
  }

  /** Closes every open result panel, used when the bridge restarts and results become invalid. */
  static closeAll(): void {
    for (const instance of [...ResultPanel.registry.values()]) {
      instance.panel.dispose();
    }
    ResultPanel.registry.clear();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly options: ResultPanelOptions,
  ) {
    this.pageSize = vscode.workspace.getConfiguration().get<number>(Config.fetchSize, DEFAULT_PAGE_SIZE);
    this.onRerun = options.onRerun;

    this.panel.webview.html = renderHtml(this.panel.webview, options.extensionUri);
    this.panel.iconPath = new vscode.ThemeIcon('table');

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) =>
        this.handleMessage(message),
      ),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  // ------------------------------------------------------------------
  // content
  // ------------------------------------------------------------------

  /**
   * Marks the panel as busy with a statement.
   *
   * @param queryId identifier the request was sent under, so Cancel has something to cancel before
   *                any result exists
   */
  setRunning(sql: string, connectionName: string, queryId?: string): void {
    this.sourceSql = sql;
    this.connectionName = connectionName;
    this.queryId = undefined;
    this.runningQueryId = queryId;
    this.columns = [];
    this.post({ type: 'running', sql, connectionName });
  }

  /** Displays a completed result set. */
  setResult(result: QueryExecuteResult, sql: string, connectionName: string): void {
    this.sourceSql = sql;
    this.connectionName = connectionName;
    this.queryId = result.queryId;
    this.runningQueryId = undefined;
    this.columns = (result.columns ?? []).map(toGridColumn);

    const message: HostToWebviewMessage = {
      type: 'result',
      sql,
      connectionName,
      columns: this.columns,
      rows: toGridRows(result.rows ?? []),
      offset: result.offset ?? 0,
      totalRows: result.totalRows ?? 0,
      truncated: result.truncated === true,
      truncatedAt: result.truncatedAt,
      pageSize: this.pageSize,
      elapsedMillis: result.elapsedMillis,
    };
    this.panel.title = `Result - ${connectionName}`;
    this.post(message);
  }

  /** Displays the outcome of a statement that returned no rows. */
  setUpdate(updateCount: number, elapsedMillis: number, sql: string, connectionName: string): void {
    this.sourceSql = sql;
    this.connectionName = connectionName;
    this.queryId = undefined;
    this.runningQueryId = undefined;
    this.post({
      type: 'update',
      sql,
      connectionName,
      updateCount,
      elapsedMillis,
    });
  }

  /** Displays a failure. */
  setError(error: unknown, sql: string, connectionName: string): void {
    this.sourceSql = sql;
    this.connectionName = connectionName;
    this.queryId = undefined;
    this.runningQueryId = undefined;

    const code = typeof (error as { code?: unknown })?.code === 'string'
      ? ((error as { code: string }).code)
      : 'ERROR';
    const sqlState = (error as { sqlState?: string })?.sqlState;

    this.post({
      type: 'error',
      sql,
      connectionName,
      message: describeError(error),
      sqlState,
      code,
    });
    this.panel.title = `Error - ${connectionName}`;
  }

  reveal(): void {
    this.panel.reveal(undefined, true);
  }

  /** The statement this panel is showing, so it can be re-run or exported. */
  get currentSql(): string {
    return this.sourceSql;
  }

  get currentQueryId(): string | undefined {
    return this.queryId;
  }

  get currentPageSize(): number {
    return this.pageSize;
  }

  // ------------------------------------------------------------------
  // webview messages
  // ------------------------------------------------------------------

  private async handleMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        // The webview reloads whenever the panel is moved or restored, so the current content is
        // replayed rather than lost.
        if (this.lastMessage) {
          this.post(this.lastMessage);
        }
        break;

      case 'requestPage':
        await this.sendPage(message.offset, message.limit);
        break;

      case 'export':
        await this.exportCurrent();
        break;

      case 'rerun':
        if (this.onRerun) {
          await this.onRerun();
        }
        break;

      case 'cancel':
        await this.cancelRunning();
        break;

      case 'report':
        log.debug(`Result grid reported: ${message.message}`);
        break;

      default:
        break;
    }
  }

  private async sendPage(offset: number, limit: number): Promise<void> {
    if (!this.queryId) {
      return;
    }
    try {
      const page = await this.options.bridge.request<QueryFetchResult>(Methods.queryFetch, {
        queryId: this.queryId,
        offset,
        limit,
      });
      this.post({
        type: 'page',
        rows: toGridRows(page.rows ?? []),
        offset: page.offset,
        totalRows: page.totalRows,
      });
    } catch (error) {
      log.error(error, 'Fetching a result page failed');
      this.post({ type: 'pageError', message: describeError(error) });
    }
  }

  private async cancelRunning(): Promise<void> {
    // While the statement is executing, only the client-side id is known; once it finishes, the
    // result's id is the one to release.
    const target = this.runningQueryId ?? this.queryId;
    if (!target) {
      return;
    }
    try {
      await this.options.bridge.request(Methods.queryCancel, { queryId: target });
      log.debug(`Cancellation requested for query '${target}'`);
    } catch (error) {
      log.debug(`Cancelling the query failed: ${describeError(error)}`);
    }
  }

  private async exportCurrent(): Promise<void> {
    if (!this.sourceSql) {
      return;
    }

    // Export from the query id when the full result is still cached - it is already the data the
    // user is looking at - and fall back to re-running the statement when it is not.
    const connectionId = this.findConnectionId();
    if (!connectionId) {
      void vscode.window.showErrorMessage('The connection for this result is no longer open.');
      return;
    }

    await this.options.exportService.exportResult({
      connectionId,
      queryId: this.queryId,
      // Always supplied as well, so that an evicted result can be re-read by re-running the statement
      // rather than reported as a failure the user can do nothing about.
      sql: this.sourceSql,
      suggestedName: this.suggestedFileName(),
    });
  }

  /**
   * Finds the connection this panel belongs to.
   *
   * The panel key is `<connectionId>:<source>`, so the prefix identifies the connection without the
   * panel having to hold a (possibly stale) profile object.
   */
  private findConnectionId(): string | undefined {
    const separator = this.options.key.indexOf(':');
    const candidate = separator > 0 ? this.options.key.slice(0, separator) : this.options.key;
    return this.options.connections.isConnected(candidate) ? candidate : undefined;
  }

  /**
   * Base file name offered when exporting.
   *
   * Built from the connection name the last run reported rather than from the panel key, because the
   * name is the human label the user chose while the key is an identifier.
   */
  private suggestedFileName(): string {
    const base = this.connectionName.replace(/[^\w.-]+/g, '_') || 'result';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${base}-${stamp}`;
  }

  private post(message: HostToWebviewMessage): void {
    this.lastMessage = message;
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    ResultPanel.registry.delete(this.options.key);

    // The spill file is the bridge's to free, but a result nobody is looking at should not keep
    // holding part of the cache budget.
    if (this.queryId) {
      void this.options.bridge
        .request(Methods.queryClose, { queryId: this.queryId })
        .catch((error: unknown) => log.debug(`Releasing a result failed: ${describeError(error)}`));
      this.queryId = undefined;
    }

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

// ---------------------------------------------------------------------------
// placement
// ---------------------------------------------------------------------------

/**
 * Creates the panel where the user asked results to appear.
 *
 * `ViewColumn` has no "below": `Beside` always opens a group to the right. To split downwards the
 * workbench is asked for a group below first and the panel then goes into whichever column is active.
 * If that command is unavailable the panel still opens, just beside, because failing to show a result
 * is much worse than showing it in the wrong direction.
 */
async function createPanel(options: ResultPanelOptions): Promise<vscode.WebviewPanel> {
  const placement = vscode.workspace
    .getConfiguration()
    .get<string>(Config.resultOpenIn, 'below');

  const panelOptions: vscode.WebviewPanelOptions & vscode.WebviewOptions = {
    enableScripts: true,
    // The webview is repainted as the user scrolls, so it must not be torn down when it loses focus.
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, 'media')],
  };

  if (placement === 'below') {
    try {
      await vscode.commands.executeCommand('workbench.action.newGroupBelow');
      return vscode.window.createWebviewPanel(
        'open-dbclient.result',
        options.title,
        vscode.ViewColumn.Active,
        panelOptions,
      );
    } catch (error) {
      log.debug(`Could not split downwards, opening beside instead: ${String(error)}`);
    }
  }

  return vscode.window.createWebviewPanel(
    'open-dbclient.result',
    options.title,
    vscode.ViewColumn.Beside,
    panelOptions,
  );
}

// ---------------------------------------------------------------------------
// conversion
// ---------------------------------------------------------------------------

function toGridColumn(column: ResultColumnInfo): GridColumn {
  return {
    name: column.name,
    label: column.label || column.name,
    displayType: column.displayType,
    jdbcTypeName: column.jdbcTypeName,
    tableName: column.tableName,
  };
}

/**
 * Narrows protocol values to the grid's value type.
 *
 * The bridge only ever emits scalars, strings and arrays, so this is a type-level assertion rather
 * than a transformation. It exists because the types are declared in two places and a mismatch
 * should be a compile error rather than a rendering oddity.
 */
function toGridRows(rows: readonly (readonly CellValue[])[]): GridValue[][] {
  return rows.map((row) => row.map((cell) => cell as GridValue));
}

// ---------------------------------------------------------------------------
// html
// ---------------------------------------------------------------------------

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = createNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'result', 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'result', 'style.css'));

  // A strict policy: no remote content, scripts only from this extension's media folder and only
  // with the nonce, which rules out anything injected through query results.
  const contentSecurityPolicy = [
    "default-src 'none'",
    `img-src ${webview.cspSource}`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Query Result</title>
</head>
<body>
  <div id="app">
    <div id="toolbar"></div>
    <div id="viewport"><table id="grid"><thead></thead><tbody></tbody></table></div>
    <div id="status"></div>
    <div id="detail" hidden></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** A fresh nonce for the content security policy. */
function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
