import * as vscode from 'vscode';

import { Commands } from '../constants';
import type { ConnectionProfile } from '../model/ConnectionProfile';
import type { ConnectionStore } from '../model/ConnectionStore';
import type { DescribedTable } from '../model/tableDetails';
import type { ConnectionService } from '../service/ConnectionService';
import type { MetadataService } from '../service/MetadataService';
import { t } from '../util/i18n';
import { log } from '../util/logger';
import { catalogLevel } from './catalogLevel';
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

  /**
   * Table listings, keyed by connection, catalog and schema - deliberately without the folder.
   *
   * The tables folder and the views folder are two views of one listing: the same `getTables` call, the same
   * rows, split differently. Expanding each asked the database for the same thing twice, and on the drivers
   * this project is aimed at that call is the most expensive read in the tree. The name filter is applied per
   * node after the listing is read, so sharing it also means changing the filter no longer re-reads it.
   */
  private readonly listings = new Map<string, DescribedTable[]>();

  private readonly subscriptions: vscode.Disposable[] = [];

  /**
   * Case-insensitive substring that table, view, column and index names must contain.
   *
   * The editor has no built-in tree filtering, so the provider does it and reports the active filter
   * in the view's description. Without that, a filtered tree is indistinguishable from a database
   * that happens to have few objects in it.
   */
  private nameFilter = '';

  private view: vscode.TreeView<DatabaseTreeNode> | undefined;

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

  /** Gives the provider the view, so it can show the active filter where the user is looking. */
  attachView(view: vscode.TreeView<DatabaseTreeNode>): void {
    this.view = view;
    this.updateViewDescription();
  }

  get activeFilter(): string {
    return this.nameFilter;
  }

  /** Sets or clears the name filter. Passing an empty string clears it. */
  setFilter(text: string): void {
    const next = text.trim();
    if (next === this.nameFilter) {
      return;
    }
    this.nameFilter = next;
    // Every cached listing was computed under the previous filter.
    this.cache.clear();
    this.updateViewDescription();
    this.emitter.fire(undefined);
  }

  private updateViewDescription(): void {
    if (this.view) {
      this.view.description = this.nameFilter ? t('filter: {0}', this.nameFilter) : undefined;
    }
  }

  /**
   * Whether a name passes the filter. An empty filter matches everything.
   *
   * `extra` is everything else the node is known by. A table's comment is its name to the person reading
   * the tree, so a filter that compared only physical names would hide the very row they were looking
   * for - and on a schema where the comment is Chinese and the name is not, that is the common case.
   *
   * Comparison stays a plain substring search over the whole value, including the extra fields. Matching
   * word by word, or ranking matches, would make the filter's behaviour something a user cannot predict
   * from what they typed.
   */
  private matches(name: string, ...extra: readonly (string | undefined)[]): boolean {
    if (this.nameFilter === '') {
      return true;
    }
    const needle = this.nameFilter.toLowerCase();
    return [name, ...extra].some(
      (value) => value !== undefined && value.toLowerCase().includes(needle),
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
        title: t('Connect'),
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
      log.trace(`Expanding '${nodeLabel(node)}' from the cached listing (${cached.length} child/children)`);
      return cached;
    }

    const startedAt = Date.now();
    let children: DatabaseTreeNode[];
    try {
      children = await this.loadChildren(node);
    } catch (error) {
      // A failed expansion must not take the tree down. The node stays expandable so the user can
      // retry, and the reason lands in the log rather than in a modal dialog.
      log.error(
        error,
        t("Could not expand '{0}' after {1} ms", nodeLabel(node), Date.now() - startedAt),
      );
      return [];
    }

    // One line per expansion, because expanding a connection is where the metadata reads happen and
    // "which level was slow" is otherwise only answerable from the health report's totals.
    log.debug(
      `Expanded '${nodeLabel(node)}' in ${Date.now() - startedAt} ms (${children.length} child/children)`,
    );
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
    const connectionName = node.profile.name;
    const url = this.connections.urlOf(id);
    const capabilities = this.connections.capabilities(id);

    // Only ask when the answer can be used. A driver that reports catalogs are meaningless to its reads -
    // PostgreSQL, openGauss - would have its list thrown away, so calling `getCatalogs()` there is a
    // metadata round trip for nothing, and a round trip is what the slow reports are about. It also means a
    // `catalogs` rule cannot apply on those drivers: there is no level for it to change.
    const catalogs =
      capabilities?.supportsCatalogs === true
        ? await this.metadata.catalogs({ connectionId: id, connectionName, url })
        : [];

    // The driver decides whether this level is usable, not the length of the list: PostgreSQL reports every
    // database in the cluster and then ignores the catalog argument, so the level would show the connected
    // database's tables under three different names. See `catalogLevel` for the measurements.
    const level = catalogLevel(catalogs, capabilities?.supportsCatalogs === true, this.connections.catalogOf(id));
    if (level.show) {
      return catalogs.map((catalog) => ({
        kind: 'catalog' as const,
        connectionId: id,
        catalog,
      }));
    }

    // No usable level: read the schemas straight off the connection, naming the catalog it is already
    // pointed at so a rule that filters on `${catalog}` still gets a value.
    return this.childrenOfScope(id, level.catalog, undefined);
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

    const schemas = await this.metadata.schemas({
      connectionId,
      catalog,
      connectionName: this.connections.displayNameOf(connectionId),
      url: this.connections.urlOf(connectionId),
    });
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
    const tables = await this.tableListing(node.connectionId, node.catalog, node.schema);

    const wantsViews = node.folder === 'views';
    return tables
      .filter(
        (table) =>
          isView(table.type) === wantsViews &&
          this.matches(
            table.name,
            table.remarks,
            ...(table.details ?? []).map((detail) => detail.value),
          ),
      )
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
   * The table-like objects of one schema, read once and shared by the folders over it.
   *
   * No type filter is passed: which folder an object belongs in is decided from the `TABLE_TYPE` the driver
   * reports, so anything a database considers table-like somewhere still lands somewhere.
   */
  private async tableListing(
    connectionId: string,
    catalog: string | undefined,
    schema: string | undefined,
  ): Promise<DescribedTable[]> {
    const key = listingKey(connectionId, catalog, schema);
    const cached = this.listings.get(key);
    if (cached) {
      return cached;
    }

    const tables = await this.metadata.tables({
      connectionId,
      catalog,
      schema,
      connectionName: this.connections.displayNameOf(connectionId),
      url: this.connections.urlOf(connectionId),
    });
    this.listings.set(key, tables);
    return tables;
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
      connectionName: this.connections.displayNameOf(node.connectionId),
      url: this.connections.urlOf(node.connectionId),
    };

    const columns = await this.metadata.columns(reference);
    log.debug(
      `Expanded ${node.table.name}: the driver reported ${columns.length} column(s). ` +
        `Present: ${columns.map((column) => column.name).join(', ')}`,
    );

    const children: DatabaseTreeNode[] = columns
      // The column's own comment is matched too, for the same reason a table's is.
      .filter((column) => this.matches(column.name, column.remarks))
      .map((column) => ({
        kind: 'column' as const,
        connectionId: node.connectionId,
        column,
        catalog: node.catalog,
        schema: node.schema,
        table: node.table.name,
        details: node.table.details,
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
      connectionName: this.connections.displayNameOf(node.connectionId),
      url: this.connections.urlOf(node.connectionId),
    });
    return indexes
      .filter((index) => this.matches(index.name ?? ''))
      .map((index) => ({
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
    this.listings.clear();
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
    for (const key of [...this.listings.keys()]) {
      if (key.startsWith(`${connectionId}|`)) {
        this.listings.delete(key);
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

    // The listing this node was built from goes too. Without that, refreshing one schema's tables would
    // answer from the listing read before the refresh and look like the refresh did nothing.
    const listing = listingKeyOf(node);
    if (listing !== undefined) {
      this.listings.delete(listing);
    }
  }

  /** Drops every cached table listing, for use after DDL that may have changed the schema. */
  invalidateTableListings(connectionId?: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith('folder|') && (!connectionId || key.includes(`|${connectionId}|`))) {
        this.cache.delete(key);
      }
    }
    for (const key of [...this.listings.keys()]) {
      if (!connectionId || key.startsWith(`${connectionId}|`)) {
        this.listings.delete(key);
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

/**
 * Which listing a set of tables belongs to: one connection, one catalog, one schema.
 *
 * The folder is deliberately not part of it - that is the whole point of the key.
 */
function listingKey(
  connectionId: string,
  catalog: string | undefined,
  schema: string | undefined,
): string {
  return `${connectionId}|${catalog ?? ''}|${schema ?? ''}`;
}

/** The listing a node was read from, or undefined for a node that was not read from one. */
function listingKeyOf(node: DatabaseTreeNode): string | undefined {
  switch (node.kind) {
    case 'catalog':
      // A catalog whose schemas were not worth a level holds its tables directly, so it is the same listing
      // as the one below a schema-less folder.
      return listingKey(node.connectionId, node.catalog, undefined);
    case 'schema':
    case 'folder':
    case 'table':
    case 'view':
      return listingKey(node.connectionId, node.catalog, node.schema);
    default:
      return undefined;
  }
}
