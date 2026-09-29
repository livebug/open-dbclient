import type { ColumnInfo, TableInfo } from '../bridge/protocol';
import type { MetadataService } from '../service/MetadataService';
import type { ConnectionService } from '../service/ConnectionService';
import { log } from '../util/logger';

/** The parts of a table listing that qualifier grouping needs. */
type ColumnSourceTable = Pick<TableInfo, 'name' | 'schema' | 'catalog'>;

/** A column offered by completion. */
export interface CachedColumn {
  readonly name: string;
  readonly displayType: string;
  readonly primaryKey: boolean;
  /** The column's comment, which on many schemas is the name people actually use. */
  readonly remarks?: string;
}

/**
 * A named container of tables, i.e. the thing before the dot in `schema.table`.
 *
 * Schemas and catalogs are both kept here, because from the user's side they play the same role: a
 * qualifier whose completion should list the tables inside it. A database that has neither simply
 * contributes nothing.
 */
export interface CachedQualifier {
  readonly name: string;
  readonly tables: readonly string[];
  /** Shown as the completion's detail, so the two kinds can be told apart when both exist. */
  readonly kind: 'schema' | 'catalog';
}

/** Tables grouped by the schema they live in. */
export interface CachedTables {
  readonly names: readonly string[];
  /** Schema to use when resolving a bare table name; undefined when the database has no schemas. */
  readonly defaultSchema?: string;
  /** Schemas and catalogs, for completing the qualifier of a qualified name. */
  readonly qualifiers: readonly CachedQualifier[];
}

/**
 * Caches schema information for completion.
 *
 * Three tiers, because they cost very different amounts to obtain:
 *
 * - **Schemas and table names** are fetched once per connection, in the background, so the first
 *   completion is instant. This is the expensive one: a database with thousands of tables takes
 *   seconds, which is why it is both prefetched and disableable.
 * - **Column names** are fetched on demand and held in a bounded LRU. A schema's worth of columns can
 *   be far larger than its table list, so caching everything would trade a slow first completion for
 *   an unbounded memory leak.
 * - **Failures are remembered** so a database that refuses a metadata call is not asked again on
 *   every keystroke.
 */
export class MetadataCache {
  private readonly tables = new Map<string, CachedTables>();
  private readonly columns = new Map<string, readonly CachedColumn[]>();
  private readonly columnOrder: string[] = [];
  private readonly failedColumns = new Set<string>();

  private readonly tableLoads = new Map<string, Promise<void>>();
  private readonly columnLoads = new Map<string, Promise<readonly CachedColumn[]>>();

  constructor(
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionService,
  ) {}

  /** Table names known for a connection, or undefined when nothing has been loaded yet. */
  tablesFor(connectionId: string): CachedTables | undefined {
    return this.tables.get(connectionId);
  }

  /** Starts loading a connection's tables if they are not already loaded or in flight. */
  ensureTables(connectionId: string): Promise<void> {
    if (this.tables.has(connectionId)) {
      return Promise.resolve();
    }
    const existing = this.tableLoads.get(connectionId);
    if (existing) {
      return existing;
    }

    const load = this.loadTables(connectionId).finally(() => this.tableLoads.delete(connectionId));
    this.tableLoads.set(connectionId, load);
    return load;
  }

  /** Columns for a table, from the cache or loaded on demand. */
  async columnsFor(
    connectionId: string,
    table: string,
    limit: number,
  ): Promise<readonly CachedColumn[]> {
    const key = `${connectionId}|${table.toLowerCase()}`;
    const cached = this.columns.get(key);
    if (cached) {
      return cached;
    }
    if (this.failedColumns.has(key)) {
      return [];
    }

    const inFlight = this.columnLoads.get(key);
    if (inFlight) {
      return inFlight;
    }

    const load = this.loadColumns(connectionId, table)
      .then((columns) => {
        this.remember(key, columns, limit);
        return columns;
      })
      .finally(() => this.columnLoads.delete(key));

    this.columnLoads.set(key, load);
    return load;
  }

  /** Drops everything for a connection, or for every connection. */
  invalidate(connectionId?: string): void {
    if (!connectionId) {
      this.tables.clear();
      this.columns.clear();
      this.columnOrder.length = 0;
      this.failedColumns.clear();
      return;
    }

    this.tables.delete(connectionId);
    for (const key of [...this.columns.keys()]) {
      if (key.startsWith(`${connectionId}|`)) {
        this.columns.delete(key);
      }
    }
    for (const key of [...this.failedColumns]) {
      if (key.startsWith(`${connectionId}|`)) {
        this.failedColumns.delete(key);
      }
    }
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private async loadTables(connectionId: string): Promise<void> {
    if (!this.connections.isConnected(connectionId)) {
      return;
    }
    try {
      const [schemas, allTables] = await Promise.all([
        this.metadata.schemas(connectionId).catch(() => [] as string[]),
        // No type filter: the completion list should include views, and every driver labels them
        // differently, so filtering would silently hide objects on some databases.
        this.metadata.tables({ connectionId }),
      ]);

      const names = allTables.map((table) => table.name);
      this.tables.set(connectionId, {
        names,
        // With exactly one schema, a bare table name is unambiguous; with several it is not, so no
        // default is offered and the completion list stays honest about what it can resolve.
        defaultSchema: schemas.length === 1 ? schemas[0] : undefined,
        qualifiers: buildQualifiers(schemas, allTables),
      });
      log.debug(`Completion cache: ${names.length} table(s) for '${connectionId}'`);
    } catch (error) {
      log.debug(`Could not preload tables for completion: ${String(error)}`);
    }
  }

  private async loadColumns(connectionId: string, table: string): Promise<readonly CachedColumn[]> {
    try {
      const columns: ColumnInfo[] = await this.metadata.columns({ connectionId, table });
      return columns.map((column) => ({
        name: column.name,
        displayType: column.displayType,
        primaryKey: column.primaryKey,
        remarks: column.remarks,
      }));
    } catch (error) {
      // Remembered so a table the driver cannot describe is not retried on every keystroke.
      this.failedColumns.add(`${connectionId}|${table.toLowerCase()}`);
      log.debug(`Could not load columns of '${table}': ${String(error)}`);
      return [];
    }
  }

  /** Stores columns, evicting the least recently used entries beyond the limit. */
  private remember(key: string, columns: readonly CachedColumn[], limit: number): void {
    if (columns.length === 0) {
      return;
    }
    this.columns.set(key, columns);

    const existing = this.columnOrder.indexOf(key);
    if (existing >= 0) {
      this.columnOrder.splice(existing, 1);
    }
    this.columnOrder.push(key);

    while (this.columnOrder.length > Math.max(10, limit)) {
      const oldest = this.columnOrder.shift();
      if (oldest) {
        this.columns.delete(oldest);
      }
    }
  }
}

/**
 * Groups table names under every name that can qualify them.
 *
 * A schema that contains no tables is kept as well: it is still worth completing, because the user
 * may be about to create the first table in it, and a qualifier the database reports should not
 * silently disappear from the suggestions because it happens to be empty right now.
 */
function buildQualifiers(
  schemas: readonly string[],
  tables: readonly ColumnSourceTable[],
): CachedQualifier[] {
  const found = new Map<string, { name: string; kind: 'schema' | 'catalog'; tables: Set<string> }>();

  const remember = (name: string | undefined, kind: 'schema' | 'catalog', table?: string): void => {
    if (!name) {
      return;
    }
    const key = `${kind}\u0000${name.toLowerCase()}`;
    let entry = found.get(key);
    if (!entry) {
      entry = { name, kind, tables: new Set<string>() };
      found.set(key, entry);
    }
    if (table) {
      entry.tables.add(table);
    }
  };

  for (const schema of schemas) {
    remember(schema, 'schema');
  }
  for (const table of tables) {
    remember(table.schema, 'schema', table.name);
    remember(table.catalog, 'catalog', table.name);
  }

  return [...found.values()].map((entry) => ({
    name: entry.name,
    kind: entry.kind,
    tables: [...entry.tables],
  }));
}
