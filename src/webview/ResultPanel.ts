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
import { currentLocale, t } from '../util/i18n';
import type { ConnectionService } from '../service/ConnectionService';
import type { ExportService } from '../service/ExportService';
import type { MetadataService } from '../service/MetadataService';
import type { VirtualDocumentProvider } from '../util/VirtualDocuments';
import {
  buildStatements,
  countStatement,
  qualifiedTableName,
  sourceTableOf,
  type SourceTable,
} from '../sql/statementBuilder';
import {
  DEFAULT_PAGE_SIZE,
  type GridColumn,
  type GridRowForSql,
  type GridStatementKind,
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
  /**
   * Read for one thing only: a table's primary key, and only when the user asks for a statement that
   * has to identify a row. That read is a `getColumns` call, which on the drivers this project is
   * aimed at is the expensive one, so it must never happen on the path that merely shows a result.
   */
  readonly metadata: MetadataService;
  /** Where a generated statement is opened for review. */
  readonly virtualDocuments: VirtualDocumentProvider;
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
   * Columns that identify a row, per connection and table.
   *
   * Static, so the answer outlives the panel: a user who has said that `order_no` identifies a row
   * should not be asked again for the next query against the same table. Keyed by connection as well
   * as table, because one table name means different things on two databases.
   */
  private static readonly identityCache = new Map<string, readonly number[]>();

  /** The identity columns in force for what this panel is showing. */
  private identity: readonly number[] | undefined;

  /**
   * The true total, once the user has asked for it.
   *
   * Kept because the panel is repainted on every page change and the count must survive that: asking
   * a second time would mean another full scan of a table that may be large.
   */
  private countedTotal: number | undefined;

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
    // A new statement is a different result: the old total and the old identity do not describe it.
    this.countedTotal = undefined;
    this.identity = undefined;
    this.post({ type: 'running', sql, connectionName });
  }

  /** Displays a completed result set. */
  setResult(result: QueryExecuteResult, sql: string, connectionName: string): void {
    this.sourceSql = sql;
    this.connectionName = connectionName;
    this.queryId = result.queryId;
    this.runningQueryId = undefined;
    this.columns = (result.columns ?? []).map(toGridColumn);
    this.countedTotal = undefined;
    this.identity = undefined;

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
    this.panel.title = t('Result - {0}', connectionName);
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
    this.panel.title = t('Error - {0}', connectionName);
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
        // replayed rather than lost. The result goes first: the grid clears its own derived state when
        // it receives one, so anything sent before it would be wiped.
        if (this.lastMessage) {
          this.post(this.lastMessage);
        }
        if (this.countedTotal !== undefined) {
          this.post({ type: 'totalCount', total: this.countedTotal });
        }
        if (this.identity) {
          this.postIdentity(this.identity);
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

      case 'generateSql':
        await this.generateSql(message.kind, message.rows);
        break;

      case 'countRows':
        await this.countRows();
        break;

      case 'chooseIdentityColumns':
        await this.chooseIdentityColumns();
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

  // ------------------------------------------------------------------
  // statements written from the grid
  // ------------------------------------------------------------------

  /**
   * Writes the SQL that would reproduce or change the selected rows, and shows it.
   *
   * Nothing is executed. The statements are opened in a read-only document and put on the clipboard,
   * because a grid is the wrong place to confirm a write and because the person asking for the SQL
   * usually wants to review it, adjust it, or paste it somewhere else entirely.
   */
  private async generateSql(kind: GridStatementKind, rows: readonly GridRowForSql[]): Promise<void> {
    if (rows.length === 0) {
      this.post({ type: 'sqlFailed', message: t('Select at least one row first.') });
      return;
    }

    // Where the rows came from is decided by what the driver reported per column, never by parsing the
    // statement: a result of a join has no single table to write back to.
    const source = sourceTableOf(this.columns);
    if (!source.table) {
      this.post({ type: 'sqlFailed', message: source.reason ?? t('This result cannot be written back.') });
      return;
    }
    const table = source.table;

    let identity: readonly number[] | undefined;
    if (kind !== 'insert') {
      identity = await this.resolveIdentity(table, false);
      if (!identity || identity.length === 0) {
        this.post({
          type: 'sqlFailed',
          message: t('No column was chosen to identify a row, so the statement was not written.'),
        });
        return;
      }
    }

    const outcome = buildStatements({
      kind,
      table,
      columns: this.columns,
      rows: rows.map((row) => row.original),
      identity,
      changes: rows.flatMap((row, index) =>
        (row.changes ?? []).map((change) => ({
          row: index,
          column: change.column,
          value: change.value,
          isNull: change.isNull,
        })),
      ),
      quote: this.quoteFor(),
    });

    if (!outcome.ok) {
      this.post({ type: 'sqlFailed', message: outcome.message });
      return;
    }

    const path = `${this.options.key.replace(/[^\w.-]+/g, '_')}.changes`;
    try {
      await this.options.virtualDocuments.show(path, 'sql', outcome.sql);
      await vscode.env.clipboard.writeText(outcome.sql);
    } catch (error) {
      log.debug(`Could not show the generated SQL: ${describeError(error)}`);
    }

    this.post({
      type: 'sqlReady',
      kind,
      statements: outcome.statements,
      warnings: outcome.warnings,
    });

    const summary = t(
      'Copied {0} statement(s) for {1}.',
      outcome.statements,
      qualifiedTableName(table, this.quoteFor()),
    );
    if (outcome.warnings.length > 0) {
      // A warning here means a value that cannot be written back as it stands - which is worth a
      // dialog rather than a line in the panel, because the SQL is already on the clipboard.
      void vscode.window.showWarningMessage(`${summary} ${outcome.warnings.join(' · ')}`);
    } else {
      void vscode.window.showInformationMessage(summary);
    }
  }

  /** Asks which columns identify a row, and remembers the answer for the table. */
  private async chooseIdentityColumns(): Promise<void> {
    const source = sourceTableOf(this.columns);
    if (!source.table) {
      this.post({ type: 'sqlFailed', message: source.reason ?? t('This result cannot be written back.') });
      return;
    }
    const chosen = await this.resolveIdentity(source.table, true);
    if (!chosen || chosen.length === 0) {
      return;
    }
    this.post({
      type: 'notice',
      message: t('Rows will be identified by {0}.', this.identityNames(chosen)),
    });
  }

  /**
   * The identity columns for a table: the primary key, or the user's answer.
   *
   * The metadata read is deliberately last and lazy. It is a `getColumns` call with a per-table cache
   * on the user's side, and on the slow drivers this project exists for that call is minutes; making
   * every result pay for it so that a statement *might* be requested later would be the wrong trade.
   */
  private async resolveIdentity(
    table: SourceTable,
    force: boolean,
  ): Promise<readonly number[] | undefined> {
    const connectionId = this.findConnectionId();
    if (!connectionId) {
      this.post({ type: 'sqlFailed', message: t('The connection for this result is no longer open.') });
      return undefined;
    }

    const key = `${connectionId}|${table.catalog ?? ''}|${table.schema ?? ''}|${table.name}`;
    if (!force) {
      const remembered = ResultPanel.identityCache.get(key);
      if (remembered) {
        this.identity = remembered;
        return remembered;
      }
      const primary = await this.primaryKeyColumns(connectionId, table);
      if (primary.length > 0) {
        ResultPanel.identityCache.set(key, primary);
        this.identity = primary;
        return primary;
      }
    }

    const chosen = await this.askIdentityColumns(table);
    if (!chosen || chosen.length === 0) {
      return undefined;
    }
    ResultPanel.identityCache.set(key, chosen);
    this.identity = chosen;
    return chosen;
  }

  /** The result's column indexes that the table's primary key covers, or none. */
  private async primaryKeyColumns(
    connectionId: string,
    table: SourceTable,
  ): Promise<readonly number[]> {
    try {
      const columns = await this.options.metadata.columns({
        connectionId,
        catalog: table.catalog,
        schema: table.schema,
        table: table.name,
        url: this.options.connections.urlOf(connectionId),
      });
      const keys: number[] = [];
      this.columns.forEach((column, index) => {
        const match = columns.find(
          (candidate) => candidate.name.toLowerCase() === column.name.toLowerCase(),
        );
        if (match?.primaryKey) {
          keys.push(index);
        }
      });
      if (keys.length > 0) {
        log.debug(`Identified rows of ${table.name} by its primary key: ${this.identityNames(keys)}`);
      }
      return keys;
    } catch (error) {
      // The user is asked to choose instead; failing to read a key must not make the grid unusable.
      log.debug(`Could not read the primary key of ${table.name}: ${describeError(error)}`);
      return [];
    }
  }

  /** Shows the result's columns and lets the user pick the ones that identify a row. */
  private async askIdentityColumns(table: SourceTable): Promise<readonly number[] | undefined> {
    const picked = await vscode.window.showQuickPick(
      this.columns.map((column, index) => ({
        label: column.label || column.name,
        description: column.displayType,
        detail: column.label && column.label !== column.name ? column.name : undefined,
        index,
      })),
      {
        title: t('Columns that identify a row of {0}', table.name),
        placeHolder: t('The WHERE clause is built from these; values must be unique per row'),
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!picked || picked.length === 0) {
      return undefined;
    }
    return picked.map((entry) => entry.index).sort((left, right) => left - right);
  }

  /** Tells the grid which columns are in force, so the panel can say what a statement will match. */
  private postIdentity(indexes: readonly number[]): void {
    this.post({ type: 'identityColumns', columns: indexes.map((index) => this.columns[index]?.name ?? `#${index + 1}`) });
  }

  private identityNames(indexes: readonly number[]): string {
    return indexes.map((index) => this.columns[index]?.name ?? `#${index + 1}`).join(', ');
  }

  /**
   * Counts what the statement returns in total.
   *
   * A result larger than `query.maxRows` is shown truncated, and the row count in the status bar is
   * then the ceiling rather than the answer. This runs the count the user asked for, on the same
   * connection, and keeps it: a repaint must not turn into a second scan of a large table.
   */
  private async countRows(): Promise<void> {
    const connectionId = this.findConnectionId();
    if (!connectionId) {
      this.post({ type: 'countFailed', message: t('The connection for this result is no longer open.') });
      return;
    }
    const statement = countStatement(this.sourceSql);
    if (!statement) {
      this.post({
        type: 'countFailed',
        message: t('Only a statement that returns rows can be counted.'),
      });
      return;
    }

    try {
      const result = await this.options.bridge.request<QueryExecuteResult>(
        Methods.queryExecute,
        { connectionId, sql: statement, maxRows: 1, pageSize: 1 },
        { timeoutMs: 0 },
      );
      const value = result.rows?.[0]?.[0];
      const total = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(total)) {
        throw new Error(String(value));
      }
      this.countedTotal = total;
      this.post({ type: 'totalCount', total });
      log.info(`Counted ${total} row(s) for the statement in this panel`);
      // The bridge caches every result it produces; a count nobody will page through must not hold
      // part of the budget.
      if (result.queryId) {
        void this.options.bridge
          .request(Methods.queryClose, { queryId: result.queryId })
          .catch((error: unknown) => log.debug(`Releasing the count result failed: ${describeError(error)}`));
      }
    } catch (error) {
      log.debug(`Counting the result failed: ${describeError(error)}`);
      this.post({ type: 'countFailed', message: describeError(error) });
    }
  }

  /** The driver's quote character, or undefined for a database that cannot quote at all. */
  private quoteFor(): string | undefined {
    const connectionId = this.findConnectionId();
    return connectionId
      ? this.options.connections.capabilities(connectionId)?.identifierQuoteString
      : undefined;
  }

  private async exportCurrent(): Promise<void> {
    if (!this.sourceSql) {
      return;
    }

    // Export from the query id when the full result is still cached - it is already the data the
    // user is looking at - and fall back to re-running the statement when it is not.
    const connectionId = this.findConnectionId();
    if (!connectionId) {
      void vscode.window.showErrorMessage(t('The connection for this result is no longer open.'));
      return;
    }

    await this.options.exportService.exportResult({
      connectionId,
      queryId: this.queryId,
      // Always supplied as well, so that an evicted result can be re-read by re-running the statement
      // rather than reported as a failure the user can do nothing about.
      sql: this.sourceSql,
      suggestedName: this.suggestedFileName(),
      connectionName: this.connectionName,
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
    const column = await resultAreaColumn();
    if (column !== undefined) {
      return vscode.window.createWebviewPanel(
        'open-dbclient.result',
        options.title,
        column,
        panelOptions,
      );
    }
  }

  return vscode.window.createWebviewPanel(
    'open-dbclient.result',
    options.title,
    vscode.ViewColumn.Beside,
    panelOptions,
  );
}

/**
 * The editor group results belong in.
 *
 * Splitting the editor once and then reusing that group is what keeps several results in one area.
 * Splitting per result - which is what calling `newGroupBelow` unconditionally did - turned a session
 * of five queries into five ever-thinner columns, and the SQL being edited was squeezed into what was
 * left. Later results therefore open as another tab in the group the first one created; the group is
 * re-created only when it no longer exists, i.e. after the user closed it.
 */
let resultArea: vscode.ViewColumn | undefined;

async function resultAreaColumn(): Promise<vscode.ViewColumn | undefined> {
  if (resultArea !== undefined && columnExists(resultArea)) {
    return resultArea;
  }

  try {
    await vscode.commands.executeCommand('workbench.action.newGroupBelow');
  } catch (error) {
    log.debug(`Could not split downwards, opening beside instead: ${String(error)}`);
    return undefined;
  }

  const created = vscode.window.tabGroups.activeTabGroup?.viewColumn;
  if (created === undefined) {
    return undefined;
  }
  resultArea = created;
  return created;
}

function columnExists(column: vscode.ViewColumn): boolean {
  return vscode.window.tabGroups.all.some((group) => group.viewColumn === column);
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
    // Carried so a statement written from the grid can name the table as the database does. Empty
    // strings are dropped: a driver that reports "" for "no schema" must not produce `""."t"`.
    schemaName: column.schemaName || undefined,
    catalogName: column.catalogName || undefined,
    remarks: column.remarks,
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
<html lang="${currentLocale()}">
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
