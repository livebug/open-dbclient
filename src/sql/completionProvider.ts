import * as vscode from 'vscode';

import { Config } from '../constants';
import type { ConnectionService } from '../service/ConnectionService';
import type { SqlEditorBinding } from '../service/SqlEditorBinding';
import type { MetadataCache, CachedColumn } from './metadataCache';
import { analyzeSqlContext, type SqlContext } from './sqlContext';

/**
 * SQL completion.
 *
 * Runs entirely in the extension host. Completion is latency-sensitive - a suggestion list that
 * arrives after a pause is worse than none - and a round trip to the bridge per keystroke would add
 * exactly that pause. The metadata it needs is therefore cached locally, and the bridge is only
 * consulted when a table's columns have not been seen before.
 *
 * Where it deliberately stops: no subquery or common-table-expression scoping. `WITH x AS (...)`
 * followed by a reference to `x` will not resolve, and a correlated name in a nested subquery is
 * attributed to the enclosing statement. Getting those right needs a real parser, and the failure is
 * benign - the user sees a slightly over-broad suggestion list rather than a wrong one.
 */
export class SqlCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly cache: MetadataCache,
    private readonly binding: SqlEditorBinding,
    private readonly connections: ConnectionService,
  ) {
    this.disposables.push(
      vscode.languages.registerCompletionItemProvider(
        { language: 'sql' },
        this,
        // A dot must be a trigger: after `u.` the user expects columns immediately, and waiting for
        // another keystroke would leave the list empty at the moment it is most useful.
        '.',
      ),
    );
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (!vscode.workspace.getConfiguration().get<boolean>(Config.intellisenseEnabled, true)) {
      return undefined;
    }

    const profile = this.binding.resolve(document);
    if (!profile || !this.connections.isConnected(profile.id)) {
      return undefined;
    }

    const sql = document.getText();
    const offset = document.offsetAt(position);
    const context = analyzeSqlContext(sql, offset);
    if (context.target === 'none' && !context.prefix) {
      return undefined;
    }

    const range = new vscode.Range(document.positionAt(context.replaceStart), position);

    switch (context.target) {
      case 'table':
        return [...(await this.tableItems(profile.id, range)), ...this.keywordItems(range)];
      case 'column':
        return [...(await this.columnItems(profile.id, context, range)), ...this.keywordItems(range)];
      default:
        return this.keywordItems(range);
    }
  }

  // ------------------------------------------------------------------
  // candidates
  // ------------------------------------------------------------------

  private async tableItems(connectionId: string, range: vscode.Range): Promise<vscode.CompletionItem[]> {
    await this.cache.ensureTables(connectionId);
    const tables = this.cache.tablesFor(connectionId);
    if (!tables) {
      return [];
    }

    return tables.names.map((name) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Struct);
      item.range = range;
      item.detail = 'table or view';
      // Tables sort before keywords: the user asking after `FROM` almost always wants a table.
      item.sortText = `0${name}`;
      return item;
    });
  }

  /**
   * Column candidates, scoped to the tables the statement actually mentions.
   *
   * When several tables are in play, each column is offered once per table with a qualified label, so
   * that `id` appearing in two joined tables is still two distinct, correctly attributed choices
   * rather than one ambiguous entry.
   */
  private async columnItems(
    connectionId: string,
    context: SqlContext,
    range: vscode.Range,
  ): Promise<vscode.CompletionItem[]> {
    const targets = this.resolveTargets(context);
    if (targets.length === 0) {
      // Without a recognisable FROM clause there is nothing to scope to, and offering every column in
      // the database would bury the useful entries.
      return [];
    }

    const qualify = context.qualifier === undefined && targets.length > 1;
    const items: vscode.CompletionItem[] = [];

    for (const target of targets) {
      const columns = await this.cache.columnsFor(
        connectionId,
        target.name,
        vscode.workspace.getConfiguration().get<number>(Config.intellisenseColumnCacheLimit, 500),
      );
      for (const column of columns) {
        items.push(this.columnItem(column, target, qualify, range));
      }
    }

    return items;
  }

  private columnItem(
    column: CachedColumn,
    target: { name: string; alias?: string },
    qualify: boolean,
    range: vscode.Range,
  ): vscode.CompletionItem {
    const qualifier = target.alias ?? target.name;
    // Qualifying with the alias when there is one keeps the inserted text compilable; qualifying with
    // the table name when the statement used an alias would produce SQL the database rejects.
    const label = qualify ? `${qualifier}.${column.name}` : column.name;

    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Field);
    item.range = range;
    item.detail = column.displayType;
    item.sortText = `0${column.name}`;
    if (column.primaryKey) {
      item.documentation = new vscode.MarkdownString('Primary key');
    }
    return item;
  }

  /** Maps the statement's table references onto the tables whose columns should be offered. */
  private resolveTargets(context: SqlContext): { name: string; alias?: string }[] {
    if (context.qualifier !== undefined) {
      const needle = context.qualifier.toLowerCase();
      for (const reference of context.references) {
        // Match the alias first: when a statement says `FROM users u`, the user writes `u`, not `users`.
        if (reference.alias?.toLowerCase() === needle) {
          return [{ name: reference.name, alias: reference.alias }];
        }
        if (!reference.alias && reference.name.toLowerCase() === needle) {
          return [{ name: reference.name }];
        }
        // A schema-qualified reference may be addressed by its trailing name, e.g. `public.users` as `users`.
        const shortName = reference.name.slice(reference.name.lastIndexOf('.') + 1);
        if (shortName.toLowerCase() === needle) {
          return [{ name: reference.name, alias: reference.alias }];
        }
      }
      // An unrecognised qualifier may be a table named in an enclosing statement; trying it costs one
      // metadata lookup and often succeeds where the local scan could not see far enough.
      return [{ name: context.qualifier }];
    }

    return context.references.map((reference) => ({ name: reference.name, alias: reference.alias }));
  }

  /** Statement keywords and common snippets, offered in every context. */
  private keywordItems(range: vscode.Range): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const keyword of SQL_KEYWORDS) {
      const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
      item.range = range;
      item.sortText = `1${keyword}`;
      items.push(item);
    }

    for (const [prefix, body] of Object.entries(SNIPPETS)) {
      const item = new vscode.CompletionItem(prefix, vscode.CompletionItemKind.Snippet);
      item.insertText = new vscode.SnippetString(body);
      item.detail = 'snippet';
      item.range = range;
      item.sortText = `0${prefix}`;
      items.push(item);
    }

    return items;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

/** Keywords worth suggesting. Not exhaustive: a wall of noise helps nobody. */
const SQL_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'INSERT INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE FROM',
  'CREATE TABLE',
  'CREATE VIEW',
  'ALTER TABLE',
  'DROP TABLE',
  'CREATE INDEX',
  'DROP INDEX',
  'TRUNCATE TABLE',
  'JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'INNER JOIN',
  'FULL JOIN',
  'CROSS JOIN',
  'ON',
  'UNION',
  'UNION ALL',
  'INTERSECT',
  'EXCEPT',
  'DISTINCT',
  'AS',
  'AND',
  'OR',
  'NOT',
  'NULL',
  'IS NULL',
  'IS NOT NULL',
  'IN',
  'BETWEEN',
  'LIKE',
  'EXISTS',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'WITH',
  'ASC',
  'DESC',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'COALESCE',
  'NULLIF',
  'CAST',
  'CONCAT',
  'SUBSTRING',
  'TRIM',
  'UPPER',
  'LOWER',
  'LENGTH',
  'ROUND',
  'ABS',
  'CURRENT_TIMESTAMP',
];

/** Short snippets, mirroring the abbreviations database clients conventionally provide. */
const SNIPPETS: Record<string, string> = {
  sel: 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition};',
  ins: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});',
  upd: 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};',
  del: 'DELETE FROM ${1:table}\nWHERE ${2:condition};',
  joi: 'SELECT ${1:*}\nFROM ${2:left_table} a\nJOIN ${3:right_table} b ON ${4:a.id = b.id}\nWHERE ${5:condition};',
  cre: 'CREATE TABLE ${1:name} (\n  ${2:id} ${3:INTEGER} NOT NULL,\n  PRIMARY KEY (${2:id})\n);',
  wit: 'WITH ${1:name} AS (\n  ${2:SELECT}\n)\nSELECT * FROM ${1:name};',
};
