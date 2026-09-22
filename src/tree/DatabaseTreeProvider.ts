import * as vscode from 'vscode';

import { Commands } from '../constants';
import type { ConnectionProfile } from '../model/ConnectionProfile';
import type { ConnectionStore } from '../model/ConnectionStore';
import type { ConnectionService } from '../service/ConnectionService';
import type { MetadataService } from '../service/MetadataService';
import { log } from '../util/logger';
import {
  nodeCollapsibleState,
  nodeContextValue,
  nodeDescription,
  nodeIcon,
  nodeKey,
  nodeLabel,
  nodeTooltip,
  type ConnectionNode,
  type DatabaseTreeNode,
  type FolderNode,
  type TableNode,
} from './nodeTypes';

/**
 * The connections tree.
 *
 * Two behaviours shape the structure, both aimed at not making the user click through levels that
 * carry no information:
 *
 * - **Single-child levels are collapsed.** A database with exactly one catalog does not get a catalog
 *   node; the tree goes straight to its schemas. The same applies to a lone schema. This is decided
 *   from what the driver reports rather than from any knowledge of the database brand, so it works
 *   the same on a database the extension has never seen.
 * - **Children are cached per node** and invalidated explicitly. Metadata calls are round trips to a
 *   database, and VS Code asks for children repeatedly as a tree is navigated.
 */
export class DatabaseTreeProvider
  implements vscode.TreeDataProvider<DatabaseTreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<DatabaseTreeNode | undefined>();
  private readonly cache = new Map<string, DatabaseTreeNode[]>();
  private readonly subscriptions: vscode.Disposable[] = [];

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly connections: ConnectionService,
    private readonly metadata: MetadataService,
  ) {
    this.subscriptions.push(
      this.store.onDidChange(() => this.refresh()),
      this.connections.onDidChangeState((profileId) => {
        // A connection's structure is unknown until it connects, so its cached children are
        // meaningless the moment its state changes.
        this.invalidateConnection(profileId);
        this.emitter.fire(undefined);
      }),
    );
  }

  getTreeItem(node: DatabaseTreeNode): vscode.TreeItem {
    const collapsible = nodeCollapsibleState(node);
    const item = new vscode.TreeItem(nodeLabel(node), collapsible);

    item.id = nodeKey(node);
    item.contextValue = nodeContextValue(node);
    item.iconPath = nodeIcon(node);

    const description = nodeDescription(node);
    if (description) {
      item.description = description;
    }

    const tooltipValue = nodeTooltip(node);
    if (tooltipValue) {
      item.tooltip = tooltipValue;
    }

    // Clicking a disconnected connection connects it, which saves a trip to the context menu for the
    // action that is almost always wanted.
    if (node.kind === 'connection' && !node.connected) {
      item.command = {
        command: Commands.connect,
        title: 'Connect',
        arguments: [node],
      };
    }

    return item;
  }

  async getChildren(node?: DatabaseTreeNode): Promise<DatabaseTreeNode[]> {
    if (!node) {
      return this.rootNodes();
    }

    const key = nodeKey(node);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    let children: DatabaseTreeNode[];
    try {
      children = await this.loadChildren(node);
    } catch (error) {
      // A failed expansion must not take the tree down. The node stays expandable so the user can
      // retry, and the reason lands in the log rather than in a modal dialog.
      log.error(error, `Could not expand '${nodeLabel(node)}'`);
      return [];
    }

    this.cache.set(key, children);
    return children;
  }

  /** The saved connections, with their current state attached. */
  private rootNodes(): DatabaseTreeNode[] {
    return this.store.list().map((profile) => this.toConnectionNode(profile));
  }

  private toConnectionNode(profile: ConnectionProfile): ConnectionNode {
    const state = this.connections.getState(profile.id);
    return {
      kind: 'connection',
      profile,
      connected: state.status === 'connected',
      hasError: state.status === 'error',
    };
  }

  private async loadChildren(node: DatabaseTreeNode): Promise<DatabaseTreeNode[]> {
    switch (node.kind) {
      case 'connection':
        return this.childrenOfConnection(node);
      case 'catalog':
        return this.childrenOfScope(node.connectionId, node.catalog, undefined);
      case 'schema':
        return this.foldersOf(node.connectionId, node.catalog, node.schema);
      case 'folder':
        return node.folder === 'indexes'
          ? this.childrenOfIndexFolder(node)
          : this.childrenOfTableFolder(node);
      case 'table':
      case 'view':
        return this.childrenOfTable(node);
      case 'column':
      case 'index':
        return [];
      default:
        return [];
    }
  }

  private async childrenOfConnection(node: ConnectionNode): Promise<DatabaseTreeNode[]> {
    if (!node.connected) {
      return [];
    }
    const { id } = node.profile;

    const catalogs = await this.metadata.catalogs(id);
    if (catalogs.length > 1) {
      return catalogs.map((catalog) => ({
        kind: 'catalog' as const,
        connectionId: id,
        catalog,
      }));
    }

    // Zero or one catalog: skip the level entirely rather than showing a single redundant node.
    const catalog = catalogs.length === 1 ? catalogs[0] : undefined;
    return this.childrenOfScope(id, catalog, undefined);
  }

  /** Schemas beneath a catalog, or the table folders when there are no schemas to show. */
  private async childrenOfScope(
    connectionId: string,
    catalog: string | undefined,
    schema: string | undefined,
  ): Promise<DatabaseTreeNode[]> {
    if (schema !== undefined) {
      return this.foldersOf(connectionId, catalog, schema);
    }

    const schemas = await this.metadata.schemas(connectionId, catalog);
    if (schemas.length > 1) {
      return schemas.map((name) => ({
        kind: 'schema' as const,
        connectionId,
        catalog,
        schema: name,
      }));
    }

    // A lone schema is not worth a level either.
    return this.foldersOf(connectionId, catalog, schemas.length === 1 ? schemas[0] : undefined);
  }

  private foldersOf(
    connectionId: string,
    catalog: string | undefined,
    schema: string | undefined,
  ): DatabaseTreeNode[] {
    return [
      { kind: 'folder', connectionId, catalog, schema, folder: 'tables' },
      { kind: 'folder', connectionId, catalog, schema, folder: 'views' },
    ];
  }

  /**
   * Table-like objects under a folders node.
   *
   * The driver's own `TABLE_TYPE` label decides which folder an object belongs in, so a view called
   * something unusual, or a materialised view, still lands somewhere sensible on a database whose
   * vocabulary the extension does not know.
   */
  private async childrenOfTableFolder(node: FolderNode): Promise<DatabaseTreeNode[]> {
    const tables = await this.metadata.tables({
      connectionId: node.connectionId,
      catalog: node.catalog,
      schema: node.schema,
    });

    const wantsViews = node.folder === 'views';
    return tables
      .filter((table) => isView(table.type) === wantsViews)
      .map((table) => ({
        kind: (isView(table.type) ? 'view' : 'table') as 'view' | 'table',
        connectionId: node.connectionId,
        catalog: node.catalog,
        schema: node.schema,
        table,
      }))
      .sort((a, b) => a.table.name.localeCompare(b.table.name));
  }

  /**
   * Contents of a table: its columns, plus a folder for its indexes.
   *
   * Columns are listed directly rather than behind a folder because they are what a user is looking
   * for when they expand a table, and an extra click to reach them is pure friction.
   */
  private async childrenOfTable(node: TableNode): Promise<DatabaseTreeNode[]> {
    const reference = {
      connectionId: node.connectionId,
      catalog: node.catalog,
      schema: node.schema,
      table: node.table.name,
    };

    const columns = await this.metadata.columns(reference);
    log.debug(
      `Expanded ${node.table.name}: the driver reported ${columns.length} column(s). ` +
        `Present: ${columns.map((column) => column.name).join(', ')}`,
    );

    const children: DatabaseTreeNode[] = columns.map((column) => ({
      kind: 'column' as const,
      connectionId: node.connectionId,
      column,
    }));

    // Indexes only make sense for tables; a view has none to list.
    if (node.kind === 'table') {
      children.push({
        kind: 'folder',
        connectionId: node.connectionId,
        catalog: node.catalog,
        schema: node.schema,
        folder: 'indexes',
        table: node.table.name,
      });
    }

    return children;
  }

  private async childrenOfIndexFolder(node: FolderNode): Promise<DatabaseTreeNode[]> {
    if (!node.table) {
      return [];
    }
    const indexes = await this.metadata.indexes({
      connectionId: node.connectionId,
      catalog: node.catalog,
      schema: node.schema,
      table: node.table,
    });
    return indexes.map((index) => ({
      kind: 'index' as const,
      connectionId: node.connectionId,
      index,
    }));
  }

  // ------------------------------------------------------------------
  // invalidation
  // ------------------------------------------------------------------

  /** Clears the whole cache and repaints. */
  refresh(): void {
    this.cache.clear();
    this.emitter.fire(undefined);
  }

  /** Clears one subtree and repaints from its parent. */
  refreshNode(node: DatabaseTreeNode): void {
    this.invalidateSubtree(node);
    this.emitter.fire(node);
  }

  private invalidateConnection(connectionId: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.includes(`|${connectionId}|`) || key === `connection|${connectionId}`) {
        this.cache.delete(key);
      }
    }
  }

  private invalidateSubtree(node: DatabaseTreeNode): void {
    const key = nodeKey(node);
    this.cache.delete(key);
    // Keys are hierarchical prefixes, so anything starting with this one is a descendant.
    for (const candidate of [...this.cache.keys()]) {
      if (candidate.startsWith(key)) {
        this.cache.delete(candidate);
      }
    }
  }

  /** Drops every cached table listing, for use after DDL that may have changed the schema. */
  invalidateTableListings(connectionId?: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith('folder|') && (!connectionId || key.includes(`|${connectionId}|`))) {
        this.cache.delete(key);
      }
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.emitter.dispose();
  }
}

/**
 * Whether a `TABLE_TYPE` label denotes a view.
 *
 * Matches on the substring rather than an exact value so that `VIEW`, `MATERIALIZED VIEW` and any
 * vendor spelling all land in the same folder.
 */
export function isView(tableType: string): boolean {
  return /view/i.test(tableType);
}
