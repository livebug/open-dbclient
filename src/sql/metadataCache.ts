import type { ColumnInfo, TableInfo } from '../bridge/protocol';
import type { MetadataService } from '../service/MetadataService';
import type { ConnectionService } from '../service/ConnectionService';
import { isFresh } from './cacheAge';
import { prefetchScopes } from './prefetchPlan';
import { parseQualifiedName, scopeOfTable, type QualifiedTableName } from './qualifiedName';
import { t } from '../util/i18n';
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

/** One cached value and when it was read, so an entry can age out without being invalidated by hand. */
interface CacheEntry<T> {
  readonly data: T;
  readonly loadedAt: number;
}

/**
 * How a cached listing ages.
 *
 * Injected rather than read from the settings here: this module is also reached by the unit tests, which
 * run without a VS Code host. The extension passes a reader for the setting, so a change applies to the
 * next read instead of needing a restart.
 */
export interface MetadataCacheOptions {
  /** Milliseconds a listing stays valid; 0 or less keeps it until the connection closes or a refresh. */
  readonly ttlMs?: () => number;
  /** Injectable clock, for tests. */
  readonly now?: () => number;
}

/**
 * Stop prefetching once this many tables have been collected.
 *
 * Not a correctness limit - a partial list only makes completion suggest less - but a memory bound: the
 * prefetch is the only read that can span a whole database, and on a warehouse with a huge catalog the
 * driver materialises the entire result before the first row is seen.
 */
const PREFETCH_TABLE_BUDGET = 20_000;

/**
 * Stop starting new per-schema reads after this long.
 *
 * The table budget bounds memory; this bounds time. A slow database can take minutes to walk every
 * schema, and a prefetch that runs for ten of them keeps the extension from ever retrying with a
 * fresher view. What has arrived by then is published and good enough to complete from.
 */
const PREFETCH_TIME_BUDGET_MS = 60_000;

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
  private readonly tables = new Map<string, CacheEntry<CachedTables>>();
  private readonly columns = new Map<string, CacheEntry<readonly CachedColumn[]>>();
  private readonly columnOrder: string[] = [];
  /**
   * Connections whose table prefetch failed, so completion asks once instead of on every keystroke.
   *
   * Without this the failure left nothing behind - `tables` stayed empty - and completion, which runs on
   * every keystroke, retried the whole listing each time. A rule that throws, or a bridge that is
   * restarting, then cost one broken query per character typed. Cleared with the rest of a connection's
   * state, so reconnecting or refreshing asks again.
   */
  private readonly failedTables = new Map<string, number>();

  private readonly tableLoads = new Map<string, Promise<void>>();
  private readonly columnLoads = new Map<string, Promise<readonly CachedColumn[]>>();
  private readonly ttlMs: () => number;
  private readonly now: () => number;

  constructor(
    private readonly metadata: MetadataService,
    private readonly connections: ConnectionService,
    options: MetadataCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? (() => 0);
    this.now = options.now ?? (() => Date.now());
  }

  /** True while an entry read at {@code loadedAt} is still within the configured lifetime. */
  private fresh(loadedAt: number): boolean {
    return isFresh(loadedAt, this.ttlMs(), this.now());
  }

  /**
   * Table names known for a connection.
   *
   * @param options.allowStale serve an expired listing too. Completion uses this while a refresh is
   *        in flight: a five-minute-old table name is a better suggestion than none, and the refresh
   *        replaces it when it finishes.
   */
  tablesFor(
    connectionId: string,
    options?: { allowStale?: boolean },
  ): CachedTables | undefined {
    const entry = this.tables.get(connectionId);
    if (entry === undefined) {
      return undefined;
    }
    return options?.allowStale === true || this.fresh(entry.loadedAt) ? entry.data : undefined;
  }

  /**
   * Starts loading a connection's tables if they are not fresh and not already in flight.
   *
   * An expired listing is reloaded rather than served: the tree keeps answering from its own cache in the
   * meantime, so the cost is a background read, not a blank completion list.
   */
  ensureTables(connectionId: string): Promise<void> {
    const cached = this.tables.get(connectionId);
    if (cached !== undefined && this.fresh(cached.loadedAt)) {
      return Promise.resolve();
    }
    const failedAt = this.failedTables.get(connectionId);
    if (failedAt !== undefined) {
      if (this.fresh(failedAt)) {
        return Promise.resolve();
      }
      // The failure has aged out with the listing, so asking again is worth it.
      this.failedTables.delete(connectionId);
    }
    const existing = this.tableLoads.get(connectionId);
    if (existing) {
      return existing;
    }

    const load = this.loadTables(connectionId).finally(() => this.tableLoads.delete(connectionId));
    this.tableLoads.set(connectionId, load);
    return load;
  }

  /**
   * Columns for a table, from the cache or loaded on demand.
   *
   * The name may be qualified (`public.users`), which is how it is written in the statement, but the driver
   * is asked about its parts - see {@link parseQualifiedName}. The cache is keyed on the same parts, so two
   * tables of the same name in two schemas are two entries rather than one wrong one.
   */
  async columnsFor(
    connectionId: string,
    table: string,
    limit: number,
  ): Promise<readonly CachedColumn[]> {
    const name = this.scoped(connectionId, parseQualifiedName(table));
    const key = columnKey(connectionId, name);
    const cached = this.columns.get(key);
    if (cached !== undefined && this.fresh(cached.loadedAt)) {
      return cached.data;
    }

    const inFlight = this.columnLoads.get(key);
    if (inFlight) {
      return inFlight;
    }

    const load = this.loadColumns(connectionId, name)
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
      this.failedTables.clear();
      this.columns.clear();
      this.columnOrder.length = 0;
      return;
    }

    this.tables.delete(connectionId);
    this.failedTables.delete(connectionId);
    for (const key of [...this.columns.keys()]) {
      if (key.startsWith(`${connectionId}|`)) {
        this.columns.delete(key);
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
    const startedAt = Date.now();
    const scope = {
      connectionId,
      catalog: this.catalogFor(connectionId),
      connectionName: this.connections.displayNameOf(connectionId),
      url: this.connections.urlOf(connectionId),
    };
    // Said before the work rather than after it: these two reads happen while the user is looking at a
    // freshly connected tree, and if they are slow this line is what makes the cause visible.
    log.debug(
      t(
        'Prefetching the table list of {0} for completion',
        this.connections.displayNameOf(connectionId) ?? connectionId,
      ),
    );
    try {
      // Not caught here on purpose: a schema list that could not be read is different from a database
      // that has none, and that difference decides whether splitting the table read is safe.
      const schemas = await this.metadata.schemas(scope);
      const catalogs =
        schemas.length <= 1 && scope.catalog === undefined
          ? await this.metadata.catalogs(scope).catch(() => [] as string[])
          : [];
      // See prefetchScopes: one read per schema (or per catalog) rather than one over the whole
      // database, because a driver asked for everything at once materialises the whole result before
      // returning a row. An empty plan means there is no safe split and nothing is read at all.
      const scopes = prefetchScopes(schemas, catalogs, scope.catalog !== undefined);
      if (scopes.length === 0) {
        throw new Error(
          t(
            'the schema list is empty, so the table list was not read (a whole-catalog read is unsafe)',
          ),
        );
      }

      // No type filter: the completion list should include views, and every driver labels them
      // differently, so filtering would silently hide objects on some databases.
      const allTables: TableInfo[] = [];
      let truncated = false;
      let failedReads = 0;

      // Published after every batch, so a completion request can offer what has arrived while the
      // rest is still being read. Replacing the whole entry only at the end is what made a slow
      // database look like a broken completion list.
      const publish = (): void => {
        this.tables.set(connectionId, {
          data: {
            names: allTables.map((table) => table.name),
            // With exactly one schema, a bare table name is unambiguous; with several it is not, so
            // no default is offered and the completion list stays honest about what it resolves.
            defaultSchema: schemas.length === 1 ? schemas[0] : undefined,
            qualifiers: buildQualifiers(schemas, allTables),
          },
          loadedAt: this.now(),
        });
      };
      publish();

      for (const part of scopes) {
        if (allTables.length >= PREFETCH_TABLE_BUDGET) {
          truncated = true;
          break;
        }
        if (Date.now() - startedAt >= PREFETCH_TIME_BUDGET_MS) {
          truncated = true;
          break;
        }
        const batch = await this.metadata.tables({ ...scope, ...part }).catch(() => undefined);
        if (batch === undefined) {
          failedReads++;
          continue;
        }
        allTables.push(...batch);
        publish();
      }

      if (truncated) {
        log.warn(
          t(
            'Completion prefetch stopped early ({0} table(s), {1} ms); only part of the database is suggested',
            allTables.length,
            Date.now() - startedAt,
          ),
        );
      }

      if (allTables.length === 0 && failedReads > 0) {
        // Every read failed. Leaving an empty-but-successful entry behind is what turns this into a
        // silent, keyword-only completion list for the whole lifetime of the cache.
        this.tables.delete(connectionId);
        throw new Error(t('every table read failed'));
      }

      log.debug(
        t(
          'Completion cache: {0} table(s) for {1} in {2} ms',
          allTables.length,
          this.connections.displayNameOf(connectionId) ?? connectionId,
          Date.now() - startedAt,
        ),
      );
    } catch (error) {
      // Remembered, because completion runs on every keystroke and this failed once already. The
      // timestamp lets the failure age out with the listing instead of blocking retries forever.
      this.failedTables.set(connectionId, this.now());
      // Visible at the default level: "completion only shows keywords" is otherwise indistinguishable
      // from "there is nothing to complete", and this line is where the reason can be read.
      log.warn(
        t(
          'Completion has no table list for {0} after {1} ms: {2}',
          this.connections.displayNameOf(connectionId) ?? connectionId,
          Date.now() - startedAt,
          String(error),
        ),
      );
    }
  }

  private async loadColumns(
    connectionId: string,
    name: QualifiedTableName,
  ): Promise<readonly CachedColumn[]> {
    const startedAt = Date.now();
    try {
      const columns: ColumnInfo[] = await this.metadata.columns({
        connectionId,
        catalog: name.catalog ?? this.catalogFor(connectionId),
        schema: name.schema,
        table: name.table,
        connectionName: this.connections.displayNameOf(connectionId),
        url: this.connections.urlOf(connectionId),
      });
      log.debug(
        t('Loaded {0} column(s) of {1} in {2} ms', columns.length, name.table, Date.now() - startedAt),
      );
      return columns.map((column) => ({
        name: column.name,
        displayType: column.displayType,
        primaryKey: column.primaryKey,
        remarks: column.remarks,
      }));
    } catch (error) {
      // The empty answer is remembered by the caller like any other - a name the driver cannot describe is
      // not worth asking about again on the next keystroke - and this line says why it is empty.
      log.debug(
        t("Could not load columns of '{0}' after {1} ms: {2}", name.table, Date.now() - startedAt, String(error)),
      );
      return [];
    }
  }

  /**
   * The catalog these reads are scoped to, or undefined to read across all of them.
   *
   * The same decision the tree makes for the same connection. A driver that cannot read inside catalogs -
   * PostgreSQL, openGauss - gets no catalog level in the tree, and the connection's own catalog is carried
   * down instead, because it is the only one its reads can reach. Passing it here matters for more than
   * symmetry: a `metadata.queries` rule that filters on `${catalog}` is refused when the read names no
   * catalog, so the completion list would quietly fall back to the driver's metadata - the slow path the rule
   * exists to avoid. Where the driver *can* read inside catalogs the tree offers a level to pick from, and a
   * completion list has no level, so it keeps reading across all of them rather than narrowing to one.
   */
  private catalogFor(connectionId: string): string | undefined {
    return this.connections.capabilities(connectionId)?.supportsCatalogs === true
      ? undefined
      : this.connections.catalogOf(connectionId);
  }

  /**
   * Fills in what the statement left out, from the table listing that is already in hand.
   *
   * A statement that says `orders` rather than `public.orders` names no schema, and a rule that filters on
   * `${schema}` or `${schemaLiteral}` cannot be filled without one: it is refused, the driver answers instead,
   * and the read the rule was written to make fast is slow again. The listing already knows which schema each
   * table is in, so the completion list can name it even though the user did not - see {@link scopeOfTable}.
   */
  private scoped(connectionId: string, name: QualifiedTableName): QualifiedTableName {
    const known = this.tables.get(connectionId)?.data;
    return scopeOfTable(name, known?.qualifiers ?? [], known?.defaultSchema);
  }

  /**
   * Stores columns, evicting the least recently used entries beyond the limit.
   *
   * An empty result is stored too, and that is the reason this is the only place that writes: a name that is
   * not a table answers "no columns" however often it is asked, and in a `WITH x AS (...)` statement the
   * qualifier `x` is such a name. Leaving the empty answers out meant the same query went to the database on
   * every keystroke for as long as the user kept typing - exactly the traffic this cache exists to avoid.
   */
  private remember(key: string, columns: readonly CachedColumn[], limit: number): void {
    this.columns.set(key, { data: columns, loadedAt: this.now() });

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

/** One table's columns, keyed so that the same name in two schemas stays two entries. */
function columnKey(connectionId: string, name: QualifiedTableName): string {
  return `${connectionId}|${name.catalog ?? ''}|${name.schema ?? ''}|${name.table.toLowerCase()}`;
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
