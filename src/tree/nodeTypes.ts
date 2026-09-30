import * as vscode from 'vscode';

import type { ColumnInfo, IndexInfo } from '../bridge/protocol';
import type { ConnectionProfile } from '../model/ConnectionProfile';
import type { DescribedTable, TableDetail } from '../model/tableDetails';
import { t } from '../util/i18n';

/**
 * The nodes the database tree can show.
 *
 * A tagged union rather than a class hierarchy: the tree only ever switches on the kind, and plain
 * objects make the cache trivial to key and to invalidate. `contextValue` is derived separately
 * because VS Code's `when` clauses in `package.json` match on strings like `table` and
 * `connection.connected`, which is a presentation concern rather than a node identity.
 */
export type DatabaseTreeNode =
  | ConnectionNode
  | CatalogNode
  | SchemaNode
  | FolderNode
  | TableNode
  | ColumnNode
  | IndexNode;

interface NodeBase {
  readonly kind: string;
}

export interface ConnectionNode extends NodeBase {
  readonly kind: 'connection';
  readonly profile: ConnectionProfile;
  readonly connected: boolean;
  readonly hasError: boolean;
}

export interface CatalogNode extends NodeBase {
  readonly kind: 'catalog';
  readonly connectionId: string;
  readonly catalog: string;
}

export interface SchemaNode extends NodeBase {
  readonly kind: 'schema';
  readonly connectionId: string;
  readonly catalog?: string;
  readonly schema: string;
}

export interface FolderNode extends NodeBase {
  readonly kind: 'folder';
  readonly connectionId: string;
  readonly catalog?: string;
  readonly schema?: string;
  readonly folder: 'tables' | 'views' | 'indexes';
  /** Set only for the `indexes` folder, which belongs to one table. */
  readonly table?: string;
}

export interface TableNode extends NodeBase {
  readonly kind: 'table' | 'view';
  readonly connectionId: string;
  readonly catalog?: string;
  readonly schema?: string;
  readonly table: DescribedTable;
}

export interface ColumnNode extends NodeBase {
  readonly kind: 'column';
  readonly connectionId: string;
  readonly column: ColumnInfo;
  /**
   * The table the column belongs to.
   *
   * Carried on the node because a column is meaningless without it: an action offered on a column has
   * to name a table, and the node id has to stay unique - `column|conn|id` collides between two
   * tables that both have an `id` column, which makes the tree reuse the wrong expansion state.
   */
  readonly catalog?: string;
  readonly schema?: string;
  readonly table: string;
  /**
   * The extra fields the metadata rule returned for the table this column belongs to.
   *
   * Here so that an action on a column can use the same fields as an action on its table: the difference
   * between the two is which node the user right-clicked, and that should not decide what a template can
   * say about the table.
   */
  readonly details?: readonly TableDetail[];
}

export interface IndexNode extends NodeBase {
  readonly kind: 'index';
  readonly connectionId: string;
  readonly index: IndexInfo;
}

/**
 * A stable identity for a node.
 *
 * Assigned to `TreeItem.id` so VS Code can keep a subtree expanded across a refresh. Without it,
 * every refresh collapses the whole tree, which is maddening on a database with a deep schema.
 */
export function nodeKey(node: DatabaseTreeNode): string {
  switch (node.kind) {
    case 'connection':
      return `connection|${node.profile.id}`;
    case 'catalog':
      return `catalog|${node.connectionId}|${node.catalog}`;
    case 'schema':
      return `schema|${node.connectionId}|${node.catalog ?? ''}|${node.schema}`;
    case 'folder':
      return `folder|${node.connectionId}|${node.catalog ?? ''}|${node.schema ?? ''}|${node.folder}|${
        node.table ?? ''
      }`;
    case 'table':
    case 'view':
      return `${node.kind}|${node.connectionId}|${node.catalog ?? ''}|${node.schema ?? ''}|${node.table.name}`;
    case 'column':
      return `column|${node.connectionId}|${node.catalog ?? ''}|${node.schema ?? ''}|${node.table}|${node.column.name}`;
    case 'index':
      return `index|${node.connectionId}|${node.index.name}|${node.index.ordinal}`;
    default:
      return 'unknown';
  }
}

/**
 * The `contextValue` used by `package.json` menu contributions.
 *
 * Connection nodes carry their status because the inline connect and disconnect actions are
 * mutually exclusive: showing both would let a user ask to disconnect something that is not
 * connected.
 */
export function nodeContextValue(node: DatabaseTreeNode): string {
  switch (node.kind) {
    case 'connection':
      if (node.hasError) {
        return 'connection.error';
      }
      return node.connected ? 'connection.connected' : 'connection.disconnected';
    case 'catalog':
      return 'catalog';
    case 'schema':
      return 'schema';
    case 'folder':
      return 'folder';
    case 'table':
      return 'table';
    case 'view':
      return 'view';
    case 'column':
      return 'column';
    case 'index':
      return 'index';
    default:
      return 'unknown';
  }
}

export function nodeLabel(node: DatabaseTreeNode): string {
  switch (node.kind) {
    case 'connection':
      return node.profile.name || node.profile.url;
    case 'catalog':
      return node.catalog;
    case 'schema':
      return node.schema;
    case 'folder':
      return folderLabel(node.folder);
    case 'table':
    case 'view':
      return node.table.name;
    case 'column':
      return node.column.name;
    case 'index':
      return node.index.name || t('(unnamed index)');
    default:
      return t('unknown');
  }
}

export function nodeDescription(node: DatabaseTreeNode): string | undefined {
  switch (node.kind) {
    case 'connection':
      return node.profile.user || undefined;
    case 'table':
    case 'view':
      return tableDescription(node.table, node.kind);
    case 'column':
      return columnDescription(node.column);
    case 'index':
      return node.index.unique ? t('unique') : undefined;
    default:
      return undefined;
  }
}

/**
 * The dimmed text after a table's name: its comment, then the driver's type label when that label says
 * something.
 *
 * The comment goes here rather than into the label because the label is what the user copies into a
 * query - `SELECT * FROM sales_orders` - while the comment is what they recognise. Swapping them would
 * make the tree readable and the SQL wrong.
 */
function tableDescription(table: DescribedTable, kind: 'table' | 'view'): string | undefined {
  // The comment is shown as written. A leading or trailing space would silently break the ` · ` join, and
  // a catalog that stores an empty comment for "none" is common enough that it is treated as none.
  const remark = table.remarks?.trim();
  const parts = [remark === undefined || remark === '' ? undefined : remark];
  if (!isPlainType(kind, table.type)) {
    parts.push(table.type);
  }
  const shown = parts.filter((part): part is string => part !== undefined);
  return shown.length === 0 ? undefined : shown.join(' · ');
}

export function nodeTooltip(node: DatabaseTreeNode): vscode.MarkdownString | undefined {
  const tooltip = new vscode.MarkdownString();
  switch (node.kind) {
    case 'connection':
      tooltip.appendMarkdown(`**${escapeMarkdown(node.profile.name)}**\n\n`);
      tooltip.appendCodeblock(`${node.profile.driverClassName}\n${node.profile.url}`, 'text');
      return tooltip;
    case 'table':
    case 'view': {
      const { table } = node;
      tooltip.appendMarkdown(`**${escapeMarkdown(table.name)}** _(${escapeMarkdown(table.type)})_\n\n`);
      if (table.remarks) {
        tooltip.appendMarkdown(`${escapeMarkdown(table.remarks)}\n\n`);
      }
      // Every field the metadata rule returned beyond the contract, as returned. Kept out of the
      // description because a tree row is one line: an extra row count or engine name belongs in the
      // tooltip, where there is room to read it.
      for (const detail of table.details ?? []) {
        tooltip.appendMarkdown(`${escapeMarkdown(detail.name)}: ${escapeMarkdown(detail.value)}\n\n`);
      }
      tooltip.appendCodeblock(qualifiedName(table.catalog, table.schema, table.name), 'sql');
      return tooltip;
    }
    case 'column':
      tooltip.appendMarkdown(`**${escapeMarkdown(node.column.name)}**\n\n`);
      tooltip.appendMarkdown(t('Type: `{0}`', escapeMarkdown(node.column.typeName)));
      if (node.column.nullable) {
        tooltip.appendMarkdown(t(' · nullable'));
      }
      if (node.column.defaultValue) {
        tooltip.appendMarkdown(t(' · default `{0}`', escapeMarkdown(node.column.defaultValue)));
      }
      if (node.column.remarks) {
        tooltip.appendMarkdown(`\n\n${escapeMarkdown(node.column.remarks)}`);
      }
      return tooltip;
    case 'index':
      tooltip.appendMarkdown(`**${escapeMarkdown(node.index.name || t('(unnamed index)'))}**\n\n`);
      tooltip.appendMarkdown(
        `${node.index.unique ? t('Unique') : t('Non-unique')} · ${escapeMarkdown(node.index.typeName)}`,
      );
      if (node.index.columnName) {
        tooltip.appendMarkdown(`\n\n${t('Column: `{0}`', escapeMarkdown(node.index.columnName))}`);
      }
      return tooltip;
    default:
      return undefined;
  }
}

export function nodeIcon(node: DatabaseTreeNode): vscode.ThemeIcon {
  switch (node.kind) {
    case 'connection':
      if (node.hasError) {
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
      }
      return node.connected
        ? new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.green'))
        : new vscode.ThemeIcon('plug');
    case 'catalog':
      return new vscode.ThemeIcon('database');
    case 'schema':
      return new vscode.ThemeIcon('symbol-namespace');
    case 'folder':
      switch (node.folder) {
        case 'tables':
          return new vscode.ThemeIcon('list-flat');
        case 'views':
          return new vscode.ThemeIcon('eye');
        case 'indexes':
          return new vscode.ThemeIcon('list-ordered');
      }
      return new vscode.ThemeIcon('folder');
    case 'table':
      return new vscode.ThemeIcon('table');
    case 'view':
      return new vscode.ThemeIcon('eye');
    case 'column':
      return node.column.primaryKey
        ? new vscode.ThemeIcon('key', new vscode.ThemeColor('charts.yellow'))
        : new vscode.ThemeIcon('symbol-field');
    case 'index':
      return new vscode.ThemeIcon('list-ordered');
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

/** Collapsibility, decided without touching the database. */
export function nodeCollapsibleState(node: DatabaseTreeNode): vscode.TreeItemCollapsibleState {
  switch (node.kind) {
    case 'connection':
      // A disconnected connection has nothing to show, and expanding it would produce an empty
      // branch with no explanation.
      return node.connected
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    case 'column':
    case 'index':
      return vscode.TreeItemCollapsibleState.None;
    default:
      return vscode.TreeItemCollapsibleState.Collapsed;
  }
}

/** True when the label and type agree, so no redundant type suffix is needed. */
function isPlainType(kind: 'table' | 'view', type: string): boolean {
  return kind === 'view' ? /^views?$/i.test(type) : /^tables?$/i.test(type);
}

function columnDescription(column: ColumnInfo): string {
  const parts: string[] = [column.displayType];
  if (column.primaryKey) {
    parts.push(t('PK'));
  }
  if (column.nullableKnown && !column.nullable) {
    parts.push(t('not null'));
  }
  if (column.autoIncrement) {
    parts.push(t('auto'));
  }
  return parts.join(' · ');
}

function folderLabel(folder: FolderNode['folder']): string {
  switch (folder) {
    case 'tables':
      return t('Tables');
    case 'views':
      return t('Views');
    case 'indexes':
      return t('Indexes');
  }
}

/** Renders `catalog.schema.name` with whatever parts are present. */
export function qualifiedName(catalog?: string, schema?: string, name?: string): string {
  return [catalog, schema, name].filter((part) => part !== undefined && part !== '').join('.');
}

/** Escapes characters that would otherwise start formatting in a Markdown tooltip. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}
