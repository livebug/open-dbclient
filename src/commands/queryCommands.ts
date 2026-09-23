import * as vscode from 'vscode';

import { Commands, Config, connectionDirective } from '../constants';import { Methods } from '../bridge/protocol';
import type { QueryExecuteResult } from '../bridge/protocol';
import { profileLabel, type ConnectionProfile } from '../model/ConnectionProfile';
import type { DatabaseTreeNode, TableNode } from '../tree/nodeTypes';
import { qualifiedName } from '../tree/nodeTypes';
import type { HistoryNode } from '../tree/HistoryTreeProvider';
import { isSqlDocument } from '../service/SqlEditorBinding';
import { VariablePanel } from '../webview/VariablePanel';
import {
  appliesTo,
  expandAction,
  parseActions,
  unresolvedPlaceholders,
} from '../sql/actionTemplate';
import { ResultPanel } from '../webview/ResultPanel';
import {
  isDestructive,
  resolveStatementToRun,
  splitStatements,
} from '../util/sqlStatementParser';
import { describeError, log } from '../util/logger';
import type { CommandDependencies } from './types';

/** Commands that run statements and inspect schema. */
export function registerQueryCommands(dependencies: CommandDependencies): vscode.Disposable[] {
  const register = (command: string, handler: (...args: unknown[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(command, handler);

  return [
    register(Commands.openQuery, (node) => openQuery(dependencies, node)),
    register(Commands.runQuery, () => runFromEditor(dependencies, false)),
    register(Commands.runStatement, (range) =>
      runSingleStatement(dependencies, range as vscode.Range | undefined),
    ),
    register(Commands.runAllQueries, () => runFromEditor(dependencies, true)),
    register(Commands.runQueryFromTree, (node) => runTablePreview(dependencies, asNode(node))),
    register(Commands.runCustomAction, (node) => runCustomAction(dependencies, asNode(node))),
    register(Commands.cancelQuery, () => cancelCurrent(dependencies)),
    register(Commands.exportResult, () => exportFromEditor(dependencies)),
    register(Commands.exportTable, (node) => exportTable(dependencies, asNode(node))),
    register(Commands.viewColumns, (node) => showColumns(dependencies, asNode(node))),
    register(Commands.viewIndexes, (node) => showIndexes(dependencies, asNode(node))),
    register(Commands.generateDdl, (node) => showDdl(dependencies, asNode(node))),
    register(Commands.refreshMetadataCache, () => {
      // Both caches describe the same schema and go stale for the same reasons, so refreshing one
      // without the other would leave completion offering tables that no longer exist.
      dependencies.metadataCache.invalidate();
      dependencies.tree.refresh();
      void vscode.window.showInformationMessage('Schema information refreshed.');
    }),
    register(Commands.insertHistoryEntry, (node) => insertHistory(asHistoryNode(node))),
    register(Commands.deleteHistoryEntry, (node) =>
      deleteHistory(dependencies, asHistoryNode(node)),
    ),
    register(Commands.clearHistory, () => clearHistory(dependencies)),
  ];
}

function asNode(value: unknown): DatabaseTreeNode | undefined {
  return typeof value === 'object' && value !== null && 'kind' in value
    ? (value as DatabaseTreeNode)
    : undefined;
}

/**
 * Narrowing for query-history items.
 *
 * These are a different shape from tree nodes and carry no `kind`, so reusing `asNode` for them
 * silently produced `undefined` and the commands returned without doing anything at all.
 */
function asHistoryNode(value: unknown): HistoryNode | undefined {
  return typeof value === 'object' && value !== null && 'entry' in value
    ? (value as HistoryNode)
    : undefined;
}

// ---------------------------------------------------------------------------
// running statements
// ---------------------------------------------------------------------------

/** Creates a SQL file already attached to a connection. */
async function openQuery(
  dependencies: CommandDependencies,
  node: unknown,
): Promise<void> {
  const target = asNode(node);
  let profile: ConnectionProfile | undefined;

  if (target?.kind === 'connection') {
    profile = target.profile;
  } else {
    const options = dependencies.store.list().map((candidate) => ({
      label: profileLabel(candidate),
      description: candidate.url,
      profile: candidate,
    }));
    if (options.length === 0) {
      void vscode.window.showInformationMessage('Add a connection first.');
      return;
    }
    profile = options.length === 1
      ? options[0].profile
      : (await vscode.window.showQuickPick(options, { title: 'Connection' }))?.profile;
  }
  if (!profile) {
    return;
  }

  const document = await vscode.workspace.openTextDocument({
    language: 'sql',
    content: `${connectionDirective(profile.name)}\n\nSELECT 1;\n`,
  });
  await vscode.window.showTextDocument(document);
}

/** Runs the selection, or the statement under the cursor, or the whole script. */
async function runFromEditor(
  dependencies: CommandDependencies,
  wholeScript: boolean,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isSqlDocument(editor.document)) {
    void vscode.window.showInformationMessage('Open a SQL file to run a query.');
    return;
  }

  const profile = await resolveProfile(dependencies, editor.document);
  if (!profile) {
    return;
  }

  await ensureConnected(dependencies, profile);

  if (wholeScript) {
    const statements = splitStatements(editor.document.getText());
    if (statements.length === 0) {
      void vscode.window.showInformationMessage('There is nothing to run.');
      return;
    }
    if (statements.length > 1) {
      const confirmed = await vscode.window.showWarningMessage(
        `Run all ${statements.length} statements?`,
        { modal: true },
        'Run All',
      );
      if (confirmed !== 'Run All') {
        return;
      }
    }
    for (const statement of statements) {
      if (!(await confirmIfDestructive(statement.text))) {
        return;
      }
      await execute(dependencies, editor, profile, statement.text);
    }
    return;
  }

  const selection = {
    isEmpty: editor.selection.isEmpty,
    start: editor.document.offsetAt(editor.selection.start),
    end: editor.document.offsetAt(editor.selection.end),
  };
  const sql = resolveStatementToRun(
    editor.document.getText(),
    selection,
    editor.document.offsetAt(editor.selection.active),
  );

  if (!sql) {
    void vscode.window.showInformationMessage('There is no statement at the cursor.');
    return;
  }
  if (!(await confirmIfDestructive(sql))) {
    return;
  }
  await execute(dependencies, editor, profile, sql);
}

/**
 * Runs one statement identified by an explicit range.
 *
 * Used by the code lens above each statement. The range is carried by the lens rather than derived
 * from the cursor, because between drawing the lens and clicking it the user may have moved the
 * cursor elsewhere, and running a statement other than the one clicked would be indefensible.
 */
async function runSingleStatement(
  dependencies: CommandDependencies,
  range: vscode.Range | undefined,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isSqlDocument(editor.document) || !range) {
    return;
  }

  const profile = await resolveProfile(dependencies, editor.document);
  if (!profile) {
    return;
  }
  await ensureConnected(dependencies, profile);

  const sql = editor.document.getText(range);
  if (!sql.trim()) {
    return;
  }
  if (!(await confirmIfDestructive(sql))) {
    return;
  }
  await execute(dependencies, editor, profile, sql);
}

/** Runs a statement and routes the outcome into the result panel. */async function execute(
  dependencies: CommandDependencies,
  editor: vscode.TextEditor,
  profile: ConnectionProfile,
  rawSql: string,
): Promise<void> {
  // Parameters are resolved here rather than at each call site, so the code lens, the keybinding and
  // "Run again" all behave the same way. Re-running therefore picks up edits to the values.
  const resolved = dependencies.variables.resolve(rawSql);
  if (resolved.missing.length > 0) {
    // Placeholders without a value are left in the statement rather than blanked out, and the run is
    // refused: sending `> ` to a database would either fail confusingly or query something else.
    VariablePanel.show(dependencies.variables);
    void vscode.window.showWarningMessage(
      `Fill in ${resolved.missing.map((name) => `\${${name}}`).join(', ')} before running this statement.`,
    );
    return;
  }
  const sql = resolved.sql;

  const panel = await ResultPanel.show({
    key: `${profile.id}:${editor.document.uri.toString()}`,
    title: `Result - ${profileLabel(profile)}`,
    extensionUri: dependencies.extensionUri,
    bridge: dependencies.bridge,
    connections: dependencies.connections,
    exportService: dependencies.exportService,
    onRerun: async () => {
      await execute(dependencies, editor, profile, sql);
    },
  });
  const queryId = nextQueryId();
  panel.setRunning(sql, profileLabel(profile), queryId);

  const startedAt = Date.now();
  try {
    const result = await dependencies.bridge.request<QueryExecuteResult>(
      Methods.queryExecute,
      {
        connectionId: profile.id,
        sql,
        // Supplied by the caller so that cancellation has something to name while the statement is
        // still executing. The bridge only generates an identifier when none is provided.
        queryId,
        // How much of a result is materialised. Exports deliberately ignore this and stream the whole
        // table, so the ceiling only bounds what the grid holds.
        maxRows: vscode.workspace.getConfiguration().get<number>(Config.maxRows, 100_000),
        pageSize: vscode.workspace.getConfiguration().get<number>(Config.fetchSize, 200),
        fetchSize: vscode.workspace.getConfiguration().get<number>(Config.fetchSize, 200),
      },
      // A query has no deadline: it is the user's to cancel, and imposing a timeout would abort
      // legitimate long-running work with no way to opt out.
      { timeoutMs: 0 },
    );

    dependencies.history.record({
      sql,
      connectionId: profile.id,
      connectionName: profileLabel(profile),
      elapsedMillis: result.elapsedMillis,
      succeeded: true,
      rowCount: result.hasResultSet ? result.totalRows : result.updateCount,
    });

    if (result.hasResultSet) {
      panel.setResult(result, sql, profileLabel(profile));
    } else {
      panel.setUpdate(result.updateCount ?? 0, result.elapsedMillis, sql, profileLabel(profile));
    }

    // A statement that changed the schema invalidates what the tree is showing.
    if (/\b(create|drop|alter|rename)\b/i.test(sql)) {
      dependencies.tree.invalidateTableListings(profile.id);
    }
  } catch (error) {
    dependencies.history.record({
      sql,
      connectionId: profile.id,
      connectionName: profileLabel(profile),
      elapsedMillis: Date.now() - startedAt,
      succeeded: false,
      errorMessage: describeError(error),
    });
    panel.setError(error, sql, profileLabel(profile));
  }
}

/**
 * Runs a dialect-free "show me this table" query.
 *
 * The statement is plain `SELECT * FROM <table>` with a row ceiling applied at the protocol level via
 * `maxRows`. Every alternative - `LIMIT`, `TOP`, `ROWNUM` - would be a dialect, and the ceiling is
 * already expressible in standard JDBC, so none of them are needed.
 */
async function runTablePreview(
  dependencies: CommandDependencies,
  node: DatabaseTreeNode | undefined,
): Promise<void> {
  if (node?.kind !== 'table' && node?.kind !== 'view') {
    return;
  }
  const table = node as TableNode;

  const profile = dependencies.store.find(table.connectionId);
  if (!profile) {
    void vscode.window.showErrorMessage('The connection for this table is no longer saved.');
    return;
  }

  await ensureConnected(dependencies, profile);

  const quote = dependencies.connections.capabilities(profile.id)?.identifierQuoteString;
  const parts = [table.schema, table.table.name].filter((part): part is string => Boolean(part));
  const sql = `SELECT * FROM ${parts.map((part) => quoteIdentifier(quote, part)).join('.')}`;

  const limit = vscode.workspace.getConfiguration().get<number>(Config.fetchSize, 200);
  const panel = await ResultPanel.show({
    key: `${profile.id}:table:${qualifiedName(table.catalog, table.schema, table.table.name)}`,
    title: `${table.table.name}`,
    extensionUri: dependencies.extensionUri,
    bridge: dependencies.bridge,
    connections: dependencies.connections,
    exportService: dependencies.exportService,
    onRerun: async () => {
      await runTablePreview(dependencies, node);
    },
  });
  const queryId = nextQueryId();
  panel.setRunning(sql, profileLabel(profile), queryId);

  try {
    const result = await dependencies.bridge.request<QueryExecuteResult>(
      Methods.queryExecute,
      { connectionId: profile.id, sql, queryId, maxRows: limit, pageSize: limit },
      { timeoutMs: 0 },
    );
    panel.setResult(result, sql, profileLabel(profile));
  } catch (error) {
    panel.setError(error, sql, profileLabel(profile));
  }
}

/**
 * Runs a user-defined SQL action against the node it was invoked on.
 *
 * The statement is opened in a real, bound editor rather than executed invisibly. That costs one
 * document and buys three things: the user sees exactly what ran, can correct it and run it again,
 * and the result panel needs no second code path for a source that is not an editor.
 */
async function runCustomAction(
  dependencies: CommandDependencies,
  node: DatabaseTreeNode | undefined,
): Promise<void> {
  const target = actionTargetOf(node);
  if (!target) {
    return;
  }

  const parsed = parseActions(
    vscode.workspace.getConfiguration().get<unknown>(Config.customActions),
  );
  for (const problem of parsed.problems) {
    log.warn(`Custom action definition ignored: ${problem}`);
  }

  const applicable = parsed.actions.filter((action) => appliesTo(action, target.kind));
  if (applicable.length === 0) {
    const action = await vscode.window.showInformationMessage(
      parsed.actions.length === 0
        ? 'No custom actions are defined yet.'
        : `None of the ${parsed.actions.length} custom action(s) applies to a ${target.kind}.`,
      'Open Settings',
    );
    if (action === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', Config.customActions);
    }
    return;
  }

  const subject = target.column ? `${target.table}.${target.column}` : target.table;
  const picked =
    applicable.length === 1
      ? applicable[0]
      : (
          await vscode.window.showQuickPick(
            applicable.map((action) => ({
              label: action.icon ? `${action.icon} ${action.label}` : action.label,
              description: action.description,
              detail: action.sql,
              action,
            })),
            { title: `Run an action on ${subject}`, matchOnDescription: true, matchOnDetail: true },
          )
        )?.action;
  if (!picked) {
    return;
  }

  const profile = dependencies.store.find(target.connectionId);
  if (!profile) {
    void vscode.window.showErrorMessage('The connection for this object is no longer saved.');
    return;
  }
  await ensureConnected(dependencies, profile);

  const quote = dependencies.connections.capabilities(profile.id)?.identifierQuoteString;
  const quote2 = (name: string | undefined) => (name ? quoteIdentifier(quote, name) : '');
  const context = {
    table: quote2(target.table),
    schema: quote2(target.schema),
    catalog: quote2(target.catalog),
    // Matches how table preview qualifies a name: schema.table. A catalog is offered separately
    // because databases that have catalogs and no schemas would otherwise get a two-part name built
    // from an empty schema.
    qualifiedTable: [quote2(target.schema), quote2(target.table)].filter(Boolean).join('.'),
    connectionName: profileLabel(profile),
    column: quote2(target.column),
  };

  const unresolved = unresolvedPlaceholders(picked.sql, context);
  if (unresolved.length > 0) {
    void vscode.window.showWarningMessage(
      `The action '${picked.label}' uses ${unresolved.join(', ')}, which is not available on a ${target.kind}.`,
    );
    return;
  }

  const sql = expandAction(picked.sql, context);
  const document = await vscode.workspace.openTextDocument({
    language: 'sql',
    content: `${connectionDirective(profile.name)}\n\n${sql}\n`,
  });
  const editor = await vscode.window.showTextDocument(document, { preview: false });

  if (!(await confirmIfDestructive(sql))) {
    return;
  }
  await execute(dependencies, editor, profile, sql);
}

/** What a node offers to an action template, or undefined for a node actions do not apply to. */
function actionTargetOf(node: DatabaseTreeNode | undefined):
  | {
      kind: 'table' | 'view' | 'column';
      connectionId: string;
      catalog?: string;
      schema?: string;
      table: string;
      column?: string;
    }
  | undefined {
  if (!node) {
    return undefined;
  }
  switch (node.kind) {
    case 'table':
    case 'view':
      return {
        kind: node.kind,
        connectionId: node.connectionId,
        catalog: node.catalog,
        schema: node.schema,
        table: node.table.name,
      };
    case 'column':
      return {
        kind: 'column',
        connectionId: node.connectionId,
        catalog: node.catalog,
        schema: node.schema,
        table: node.table,
        column: node.column.name,
      };
    default:
      return undefined;
  }
}

async function cancelCurrent(dependencies: CommandDependencies): Promise<void> {  const editor = vscode.window.activeTextEditor;
  const profile = editor ? await resolveProfile(dependencies, editor.document) : undefined;
  if (!profile) {
    void vscode.window.showInformationMessage('No connection is associated with this editor.');
    return;
  }

  const queryId = ResultPanel.runningQueryIdFor(profile.id);
  if (!queryId) {
    void vscode.window.showInformationMessage('No statement is currently running.');
    return;
  }

  try {
    await dependencies.bridge.request(Methods.queryCancel, { queryId });
    log.info(`Cancellation requested for '${queryId}'`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not cancel the statement: ${describeError(error)}`);
  }
}

/** A client-side query identifier, unique within this session. */
let querySequence = 0;
function nextQueryId(): string {
  querySequence++;
  return `q${Date.now().toString(36)}-${querySequence}`;
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

async function exportFromEditor(dependencies: CommandDependencies): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isSqlDocument(editor.document)) {
    void vscode.window.showInformationMessage('Open a SQL file to export a query.');
    return;
  }

  const profile = await resolveProfile(dependencies, editor.document);
  if (!profile) {
    return;
  }

  const selection = {
    isEmpty: editor.selection.isEmpty,
    start: editor.document.offsetAt(editor.selection.start),
    end: editor.document.offsetAt(editor.selection.end),
  };
  const sql = resolveStatementToRun(
    editor.document.getText(),
    selection,
    editor.document.offsetAt(editor.selection.active),
  );
  if (!sql) {
    void vscode.window.showInformationMessage('There is no statement to export.');
    return;
  }

  await ensureConnected(dependencies, profile);

  const resolved = dependencies.variables.resolve(sql);
  if (resolved.missing.length > 0) {
    VariablePanel.show(dependencies.variables);
    void vscode.window.showWarningMessage(
      `Fill in ${resolved.missing.map((name) => `\${${name}}`).join(', ')} before exporting this statement.`,
    );
    return;
  }

  await dependencies.exportService.exportResult({
    connectionId: profile.id,
    sql: resolved.sql,
    suggestedName: profile.name.replace(/[^\w.-]+/g, '_') || 'export',
  });
}

async function exportTable(
  dependencies: CommandDependencies,
  node: DatabaseTreeNode | undefined,
): Promise<void> {
  if (node?.kind !== 'table' && node?.kind !== 'view') {
    return;
  }
  const table = node as TableNode;
  const profile = dependencies.store.find(table.connectionId);
  if (!profile) {
    void vscode.window.showErrorMessage('The connection for this table is no longer saved.');
    return;
  }

  await ensureConnected(dependencies, profile);
  const quote = dependencies.connections.capabilities(profile.id)?.identifierQuoteString;
  const parts = [table.schema, table.table.name].filter((part): part is string => Boolean(part));

  await dependencies.exportService.exportResult({
    connectionId: profile.id,
    sql: `SELECT * FROM ${parts.map((part) => quoteIdentifier(quote, part)).join('.')}`,
    suggestedName: table.table.name,
    tableName: parts.map((part) => quoteIdentifier(quote, part)).join('.'),
  });
}

// ---------------------------------------------------------------------------
// schema inspection
// ---------------------------------------------------------------------------

async function showColumns(
  dependencies: CommandDependencies,
  node: DatabaseTreeNode | undefined,
): Promise<void> {
  if (node?.kind !== 'table' && node?.kind !== 'view') {
    return;
  }
  const table = node as TableNode;
  try {
    const columns = await dependencies.metadata.columns({
      connectionId: table.connectionId,
      catalog: table.catalog,
      schema: table.schema,
      table: table.table.name,
    });

    const path = qualifiedName(table.catalog, table.schema, table.table.name);
    const lines = [
      `-- Columns of ${path}`,
      '',
      `${'#'.padEnd(5)}${'Name'.padEnd(34)}${'Type'.padEnd(26)}${'Null'.padEnd(7)}${'Key'.padEnd(5)}Default`,
      '-'.repeat(100),
    ];
    for (const column of columns) {
      lines.push(
        String(column.ordinal).padEnd(5) +
          column.name.padEnd(34) +
          column.displayType.padEnd(26) +
          (column.nullableKnown ? (column.nullable ? 'YES' : 'NO') : '?').padEnd(7) +
          (column.primaryKey ? 'PK' : '').padEnd(5) +
          (column.defaultValue ?? ''),
      );
      if (column.remarks) {
        lines.push(`${' '.repeat(5)}-- ${column.remarks}`);
      }
    }
    if (columns.length === 0) {
      lines.push('-- The driver reported no columns.');
    }

    await dependencies.virtualDocuments.show(`${path}.columns`, 'sql', lines.join('\n'));
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not read columns: ${describeError(error)}`);
  }
}

async function showIndexes(
  dependencies: CommandDependencies,
  node: DatabaseTreeNode | undefined,
): Promise<void> {
  if (node?.kind !== 'table') {
    return;
  }
  const table = node as TableNode;
  try {
    const indexes = await dependencies.metadata.indexes({
      connectionId: table.connectionId,
      catalog: table.catalog,
      schema: table.schema,
      table: table.table.name,
    });

    const grouped = new Map<string, typeof indexes>();
    for (const index of indexes) {
      const key = index.name || '(unnamed)';
      grouped.set(key, [...(grouped.get(key) ?? []), index]);
    }

    const path = qualifiedName(table.catalog, table.schema, table.table.name);
    const lines = [`-- Indexes of ${path}`, ''];
    for (const [name, members] of grouped) {
      const sorted = [...members].sort((a, b) => a.ordinal - b.ordinal);
      const columns = sorted.map((member) => member.columnName ?? '?').join(', ');
      lines.push(`${sorted[0].unique ? 'UNIQUE ' : ''}${name} (${columns})  [${sorted[0].typeName}]`);
    }
    if (indexes.length === 0) {
      lines.push('-- The driver reported no indexes.');
    }

    await dependencies.virtualDocuments.show(`${path}.indexes`, 'sql', lines.join('\n'));
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not read indexes: ${describeError(error)}`);
  }
}

async function showDdl(
  dependencies: CommandDependencies,
  node: DatabaseTreeNode | undefined,
): Promise<void> {
  if (node?.kind !== 'table' && node?.kind !== 'view') {
    return;
  }
  const table = node as TableNode;
  try {
    const ddl = await dependencies.metadata.ddl({
      connectionId: table.connectionId,
      catalog: table.catalog,
      schema: table.schema,
      table: table.table.name,
    });
    const path = qualifiedName(table.catalog, table.schema, table.table.name);
    await dependencies.virtualDocuments.show(`${path}`, 'sql', ddl);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not generate DDL: ${describeError(error)}`);
  }
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

async function insertHistory(node: HistoryNode | undefined): Promise<void> {
  if (!node) {
    // Reachable only if the menu contribution and the tree element disagree; say so rather than
    // returning in silence, which is how this command appeared to be broken rather than unhandled.
    log.debug('Insert-from-history was invoked without a history item');
    return;
  }
  const { sql } = node.entry;

  const editor = vscode.window.activeTextEditor;
  if (editor && isSqlDocument(editor.document)) {
    // Replace a selection when there is one: the user pointed at something, so appending next to it
    // would leave them with the old text still in the editor.
    await editor.edit((builder) => {
      if (editor.selection.isEmpty) {
        builder.insert(editor.selection.active, sql);
      } else {
        builder.replace(editor.selection, sql);
      }
    });
    return;
  }

  const document = await vscode.workspace.openTextDocument({
    language: 'sql',
    content: `${sql}\n`,
  });
  await vscode.window.showTextDocument(document);
}

async function deleteHistory(
  dependencies: CommandDependencies,
  node: HistoryNode | undefined,
): Promise<void> {
  if (node) {
    await dependencies.history.remove(node.entry.id);
  }
}

async function clearHistory(dependencies: CommandDependencies): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    'Clear the whole query history?',
    { modal: true },
    'Clear',
  );
  if (confirmed === 'Clear') {
    await dependencies.history.clear();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Finds the connection a document should run against, offering a picker when it has none. */
async function resolveProfile(
  dependencies: CommandDependencies,
  document: vscode.TextDocument,
): Promise<ConnectionProfile | undefined> {
  const bound = dependencies.binding.resolve(document);
  if (bound) {
    if (!dependencies.connections.isConnected(bound.id)) {
      await ensureConnected(dependencies, bound);
    }
    return bound;
  }

  const options = dependencies.store.list().map((profile) => ({
    label: profileLabel(profile),
    description: profile.url,
    profile,
  }));
  if (options.length === 0) {
    void vscode.window.showInformationMessage('Add a connection first.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(options, {
    title: 'This file is not attached to a connection',
  });
  if (!picked) {
    return undefined;
  }

  // Remember the answer: having to choose again on every run would be tedious.
  await dependencies.binding.bind(document, picked.profile);
  await ensureConnected(dependencies, picked.profile);
  return picked.profile;
}

async function ensureConnected(
  dependencies: CommandDependencies,
  profile: ConnectionProfile,
): Promise<void> {
  if (dependencies.connections.isConnected(profile.id)) {
    return;
  }
  try {
    await dependencies.connections.connect(profile, { silent: true });
  } catch {
    // connect() already surfaced the reason; the run below will fail with the same detail.
    log.debug(`Proceeding without an established connection to '${profileLabel(profile)}'`);
  }
}

/**
 * Asks before running something that looks destructive.
 *
 * Only for statements that would affect an unbounded number of rows or drop objects. Prompting on
 * every write would train the user to click through, which is how the prompt stops protecting
 * anything.
 */
async function confirmIfDestructive(sql: string): Promise<boolean> {
  if (!vscode.workspace.getConfiguration().get<boolean>(Config.confirmDangerous, true)) {
    return true;
  }
  if (!isDestructive(sql)) {
    return true;
  }

  const summary = sql.replace(/\s+/g, ' ').trim().slice(0, 120);
  const confirmed = await vscode.window.showWarningMessage(
    `This statement affects an unbounded number of rows or drops an object:\n\n${summary}`,
    { modal: true },
    'Run Anyway',
  );
  return confirmed === 'Run Anyway';
}

/**
 * Quotes an identifier with the character the database itself reported.
 *
 * There is no per-database quoting logic in the extension; the character comes from
 * `getIdentifierQuoteString()`, and a database that cannot quote is sent the bare name. This is what
 * lets generated SQL work against a database the project has never been taught about.
 */
function quoteIdentifier(quote: string | undefined, name: string): string {
  return quote ? quote + name.split(quote).join(quote + quote) + quote : name;
}
