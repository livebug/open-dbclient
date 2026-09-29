import * as vscode from 'vscode';

import { Config } from '../constants';
import type { JdbcBridge } from '../bridge/JdbcBridge';
import { Methods } from '../bridge/protocol';
import type {
  CellValue,
  ColumnInfo,
  DatabaseCapabilities,
  IndexInfo,
  QueryExecuteResult,
  QueryFetchResult,
  TableInfo,
} from '../bridge/protocol';
import { globToRegExp } from '../sql/actionTemplate';
import {
  expandMetadataSql,
  matchMetadataQuery,
  parseMetadataQueries,
  type MetadataQuery,
  type MetadataQueryKind,
  type MetadataQueryValues,
} from '../sql/metadataQueries';
import { describeError, log } from '../util/logger';
import { t } from '../util/i18n';

/** Identifies an object in a database, for the calls that need a fully qualified name. */
export interface ObjectReference {
  readonly connectionId: string;
  readonly catalog?: string;
  readonly schema?: string;
}

/**
 * A metadata read, plus the connection's URL.
 *
 * The URL travels with the request rather than being looked up here, because the caller already knows
 * which connection it is asking about and is the only one that can say for certain that the profile still
 * exists. It is used for one thing: matching a `metadata.queries` rule.
 */
export interface MetadataRequest extends ObjectReference {
  readonly url?: string;
}

export interface TableRequest extends MetadataRequest {
  /** LIKE pattern; `%` for everything. Passed to the driver unescaped. */
  readonly namePattern?: string;
  /** `TABLE_TYPE` labels to include; omit for everything the driver considers table-like. */
  readonly types?: readonly string[];
}

export interface TableReference extends ObjectReference {
  readonly table: string;
}

/**
 * Typed access to the bridge's metadata methods.
 *
 * A thin layer, but a deliberate one: it gives the tree, the SQL completion cache and the export
 * commands a single place to obtain schema information, and it centralises the wire convention that
 * an absent catalog or schema must be omitted rather than sent as an empty string - which the driver
 * would read as "objects with no schema" instead of "any schema".
 *
 * It is also where a user-written statement takes precedence over the driver: see `metadata.queries`.
 */
export class MetadataService {
  /** Problems already reported, so a rule that is read on every tree expansion is not logged every time. */
  private readonly reported = new Set<string>();

  constructor(private readonly bridge: JdbcBridge) {}

  async capabilities(connectionId: string): Promise<DatabaseCapabilities> {
    return this.request<DatabaseCapabilities>(Methods.metadataCapabilities, { connectionId });
  }

  async catalogs(connectionId: string): Promise<string[]> {
    const result = await this.request<{ catalogs: string[] }>(Methods.metadataCatalogs, {
      connectionId,
    });
    return result.catalogs ?? [];
  }

  async schemas(request: MetadataRequest): Promise<string[]> {
    const fromRule = await this.schemasFromRule(request);
    if (fromRule) {
      return fromRule;
    }

    const params: Record<string, unknown> = { connectionId: request.connectionId };
    putIfPresent(params, 'catalog', request.catalog);

    const result = await this.request<{ schemas: string[] }>(Methods.metadataSchemas, params);
    return result.schemas ?? [];
  }

  /** The `TABLE_TYPE` labels this driver uses, so callers can group without guessing. */
  async tableTypes(connectionId: string): Promise<string[]> {
    const result = await this.request<{ tableTypes: string[] }>(Methods.metadataTableTypes, {
      connectionId,
    });
    return result.tableTypes ?? [];
  }

  async tables(request: TableRequest): Promise<TableInfo[]> {
    const fromRule = await this.tablesFromRule(request);
    if (fromRule) {
      return fromRule;
    }

    const params: Record<string, unknown> = { connectionId: request.connectionId };
    putIfPresent(params, 'catalog', request.catalog);
    putIfPresent(params, 'schema', request.schema);
    if (request.namePattern) {
      params.namePattern = request.namePattern;
    }
    if (request.types && request.types.length > 0) {
      params.types = [...request.types];
    }

    const result = await this.request<{ tables: TableInfo[] }>(Methods.metadataTables, params);
    return result.tables ?? [];
  }

  async columns(reference: TableReference): Promise<ColumnInfo[]> {
    const result = await this.request<{ columns: ColumnInfo[] }>(
      Methods.metadataColumns,
      withTable(reference),
    );
    return result.columns ?? [];
  }

  async indexes(reference: TableReference): Promise<IndexInfo[]> {
    const result = await this.request<{ indexes: IndexInfo[] }>(
      Methods.metadataIndexes,
      withTable(reference),
    );
    return result.indexes ?? [];
  }

  async ddl(reference: TableReference): Promise<string> {
    const result = await this.request<{ ddl: string }>(Methods.metadataDdl, {
      ...withTable(reference),
      options: ddlOptions(),
    });
    return result.ddl ?? '';
  }

  // ------------------------------------------------------------------
  // user-written metadata SQL
  // ------------------------------------------------------------------

  /**
   * Issues a metadata request under the configured timeout.
   *
   * A driver's catalog queries cannot be cancelled - `Statement.setQueryTimeout` has nothing to attach
   * to, because the statement is created inside the driver - so a timeout here means "stop waiting", not
   * "stop working". Saying so is the point: the alternative is a bare timeout that leaves the user unable
   * to tell a slow database from a broken plugin, and unable to do anything about either.
   */
  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const seconds = vscode.workspace
      .getConfiguration()
      .get<number>(Config.metadataTimeoutSeconds, 30);
    const timeoutMs = seconds > 0 ? seconds * 1000 : 0;

    try {
      return await this.bridge.request<T>(method, params, { timeoutMs });
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code === 'TIMEOUT') {
        throw new Error(
          t(
            'Reading the database metadata took longer than {0} s, so the extension stopped waiting. The database may still be working on it. A faster query can be given in the metadata.queries setting, and metadata.timeoutSeconds raises the limit.',
            seconds,
          ),
        );
      }
      throw error;
    }
  }

  /** The rule to use for one read, or undefined to let the driver answer. */
  private ruleFor(kind: MetadataQueryKind, url: string | undefined): MetadataQuery | undefined {
    const parsed = parseMetadataQueries(
      vscode.workspace.getConfiguration().get<unknown>(Config.metadataQueries),
    );
    for (const problem of parsed.problems) {
      if (!this.reported.has(problem)) {
        this.reported.add(problem);
        log.warn(`Metadata query definition ignored: ${problem}`);
      }
    }
    if (parsed.queries.length === 0 || !url) {
      return undefined;
    }
    return matchMetadataQuery(kind, url, parsed.queries, (glob, value) =>
      globToRegExp(glob).test(value),
    );
  }

  /** Runs a rule, or returns undefined so the caller falls back to the driver. */
  private async runRule(
    rule: MetadataQuery,
    connectionId: string,
    values: MetadataQueryValues,
  ): Promise<MetadataRow[] | undefined> {
    const expanded = expandMetadataSql(rule.sql, values);
    if (expanded.missing.length > 0) {
      // Not run with the placeholder dropped: removing a filter changes which rows come back, not how
      // quickly, and a tree showing the wrong tables is worse than a slow one.
      this.reportOnce(
        `rule-missing-${rule.id}`,
        `The metadata query '${rule.id}' uses ${expanded.missing.join(', ')}, which is not available for this read; the driver's metadata is used instead.`,
      );
      return undefined;
    }

    try {
      return await this.runQuery(connectionId, expanded.sql);
    } catch (error) {
      // A rule that does not work must not take the tree with it: the driver's metadata is slower, but it
      // is there, and a mistake in a SELECT is not a reason to show an empty database.
      this.reportOnce(
        `rule-failed-${rule.id}`,
        `The metadata query '${rule.id}' failed (${describeError(error)}); the driver's metadata is used instead.`,
      );
      return undefined;
    }
  }

  /** Runs a statement to completion and reads every row it returned, keyed by column name. */
  private async runQuery(connectionId: string, sql: string): Promise<MetadataRow[]> {
    const pageSize = METADATA_PAGE_SIZE;
    const first = await this.request<QueryExecuteResult>(Methods.queryExecute, {
      connectionId,
      sql,
      // A listing has to be complete: a tree that quietly stopped at the first page would look like a
      // database with fewer tables, which is the kind of wrong an index cannot survive.
      maxRows: 0,
      pageSize,
      fetchSize: pageSize,
    });

    const names = (first.columns ?? []).map((column) => column.name.toUpperCase());
    const rows = toMetadataRows(names, first.rows ?? []);
    const queryId = first.queryId;
    const total = first.totalRows ?? rows.length;

    try {
      let cursor = rows.length;
      while (cursor < total) {
        const page = await this.request<QueryFetchResult>(Methods.queryFetch, {
          queryId,
          offset: cursor,
          limit: pageSize,
        });
        const more = toMetadataRows(names, page.rows ?? []);
        if (more.length === 0) {
          // Defensive: a stale total must not turn this into an infinite loop.
          break;
        }
        rows.push(...more);
        cursor += more.length;
      }
    } finally {
      // The spilled result is nobody's to browse, and leaving it to the cache budget would evict a result
      // the user is actually looking at.
      if (queryId) {
        void this.bridge
          .request(Methods.queryClose, { queryId })
          .catch((error: unknown) =>
            log.debug(`Releasing a metadata result failed: ${describeError(error)}`),
          );
      }
    }

    return rows;
  }

  private async schemasFromRule(request: MetadataRequest): Promise<string[] | undefined> {
    const rule = this.ruleFor('schemas', request.url);
    if (!rule) {
      return undefined;
    }

    const rows = await this.runRule(rule, request.connectionId, { catalog: request.catalog });
    if (!rows) {
      return undefined;
    }

    const schemas = rows
      .map((row) => text(row, 'TABLE_SCHEM') ?? text(row, 'SCHEMA_NAME'))
      .filter((name): name is string => name !== undefined && name !== '');

    if (schemas.length === 0 && rows.length > 0) {
      // Rows came back but no usable names: the rule is written against the wrong column names, which is
      // worth saying out loud rather than reporting as a database with no schemas.
      this.reportOnce(
        `rule-columns-${rule.id}`,
        `The metadata query '${rule.id}' returned rows but no TABLE_SCHEM column, so it was ignored.`,
      );
      return undefined;
    }
    return schemas;
  }

  private async tablesFromRule(request: TableRequest): Promise<TableInfo[] | undefined> {
    const rule = this.ruleFor('tables', request.url);
    if (!rule) {
      return undefined;
    }

    const rows = await this.runRule(rule, request.connectionId, {
      catalog: request.catalog,
      schema: request.schema,
      namePattern: request.namePattern,
    });
    if (!rows) {
      return undefined;
    }

    const described = rows.map((row) => tableFromRow(row, request)).filter((table): table is TableInfo => table !== undefined);
    if (described.length === 0 && rows.length > 0) {
      this.reportOnce(
        `rule-columns-${rule.id}`,
        `The metadata query '${rule.id}' returned rows but no TABLE_NAME column, so it was ignored.`,
      );
      return undefined;
    }
    return described;
  }

  /** Reports a rule problem once per session. */
  private reportOnce(key: string, message: string): void {
    if (this.reported.has(key)) {
      return;
    }
    this.reported.add(key);
    log.warn(message);
  }
}

/** How many rows a metadata rule is read in at a time. */
const METADATA_PAGE_SIZE = 5_000;

/** A row of a metadata rule's result, with the column names upper-cased. */
type MetadataRow = ReadonlyMap<string, CellValue>;

function toMetadataRows(names: readonly string[], rows: readonly (readonly CellValue[])[]): MetadataRow[] {
  return rows.map((values) => {
    const row = new Map<string, CellValue>();
    names.forEach((name, index) => row.set(name, values[index] ?? null));
    return row;
  });
}

/** Reads a cell as text, or undefined when it is absent or null. */
function text(row: MetadataRow, key: string): string | undefined {
  const value = row.get(key);
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : String(value);
}

/**
 * Maps one row of a `tables` rule onto what the tree and the completion cache expect.
 *
 * Column names follow `DatabaseMetaData.getTables`, and everything except the name is optional: a rule
 * that answers only with names is still a working rule, and the schema the tree asked for is used when the
 * row does not carry one.
 */
function tableFromRow(row: MetadataRow, request: TableRequest): TableInfo | undefined {
  const name = text(row, 'TABLE_NAME');
  if (name === undefined || name === '') {
    return undefined;
  }

  const type = text(row, 'TABLE_TYPE') ?? 'TABLE';
  if (request.types && request.types.length > 0 && !request.types.includes(type)) {
    return undefined;
  }

  const table: TableInfo = {
    name,
    type,
    catalog: text(row, 'TABLE_CAT') ?? text(row, 'TABLE_CATALOG') ?? request.catalog,
    schema: text(row, 'TABLE_SCHEM') ?? text(row, 'SCHEMA_NAME') ?? request.schema,
  };
  const remarks = text(row, 'REMARKS');
  return remarks ? { ...table, remarks } : table;
}

/**
 * The DDL presentation settings, read at call time.
 *
 * Read here rather than passed in by each caller so that "Show DDL" and any future caller of the same
 * metadata behave identically; a setting that only some paths honour is worse than none.
 */
function ddlOptions(): Record<string, unknown> {
  const configuration = vscode.workspace.getConfiguration();
  return {
    ifNotExists: configuration.get<boolean>(Config.ddlIfNotExists, false),
    indent: configuration.get<string>(Config.ddlIndent, '    '),
    includeIndexes: configuration.get<boolean>(Config.ddlIncludeIndexes, true),
    quoteIdentifiers: configuration.get<boolean>(Config.ddlQuoteIdentifiers, true),
  };
}

function withTable(reference: TableReference): Record<string, unknown> {
  const params: Record<string, unknown> = {
    connectionId: reference.connectionId,
    table: reference.table,
  };
  putIfPresent(params, 'catalog', reference.catalog);
  putIfPresent(params, 'schema', reference.schema);
  return params;
}

/**
 * Adds a key only when it carries a value.
 *
 * The bridge treats an absent key and an empty string differently, and so does JDBC: absent means
 * "any", empty means "the one with no name". Sending `''` for an unset catalog would filter the
 * result down to nothing on most databases.
 */
function putIfPresent(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined && value !== null && value !== '') {
    target[key] = value;
  }
}
