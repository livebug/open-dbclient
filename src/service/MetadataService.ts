import * as vscode from 'vscode';

import { Config } from '../constants';
import type { JdbcBridge } from '../bridge/JdbcBridge';
import { Methods } from '../bridge/protocol';
import type {
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
import {
  catalogNameFromRow,
  columnFromRow,
  indexFromRow,
  schemaNameFromRow,
  tableFromRow,
  tableTypeFromRow,
  toMetadataRows,
  type MetadataResult,
  type MetadataRow,
} from '../sql/metadataRows';
import type { DescribedTable } from '../model/tableDetails';
import { describeError, log, summarizeSql } from '../util/logger';
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
  /**
   * The connection's name as the user knows it, used in log lines only.
   *
   * Passed in rather than looked up here because the callers that have a profile are the ones that know its
   * name, and the id is not something a person reading the output channel can identify. Absent means the log
   * line falls back to the id.
   */
  readonly connectionName?: string;
}

export interface TableRequest extends MetadataRequest {
  /** LIKE pattern; `%` for everything. Passed to the driver unescaped. */
  readonly namePattern?: string;
  /** `TABLE_TYPE` labels to include; omit for everything the driver considers table-like. */
  readonly types?: readonly string[];
}

export interface TableReference extends ObjectReference {
  readonly table: string;
  /**
   * The connection's JDBC URL, which is what a `columns` or `indexes` rule is matched against.
   *
   * Optional so that a caller without a profile to hand still works - it then gets the driver's metadata,
   * which is the behaviour of every connection that has no rule.
   */
  readonly url?: string;
  /** The connection's name as the user knows it, for the log. See {@link MetadataRequest.connectionName}. */
  readonly connectionName?: string;
}

/**
 * What a rule run is about, for its log line.
 *
 * Passed as parts rather than as one finished phrase because the phrase is language-dependent: assembling
 * `columns of public.orders` in English and then dropping it into a sentence makes one half-translated line.
 */
interface RuleRun {
  readonly kind: MetadataQueryKind;
  /** The object, e.g. `public.orders`, or empty when the run is about the whole connection. */
  readonly scope: string;
  readonly connection: string;
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

  async catalogs(request: MetadataRequest): Promise<string[]> {
    const fromRule = await this.namesFromRule('catalogs', request, {}, catalogNameFromRow, 'TABLE_CAT');
    if (fromRule) {
      return fromRule;
    }

    log.debug(
      t("Reading the catalogs of {0} from the driver's metadata", connectionLabel(request)),
    );
    const result = await this.request<{ catalogs: string[] }>(Methods.metadataCatalogs, {
      connectionId: request.connectionId,
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

    // Logged because this is one half of the completion prefetch, and the pair is the largest single
    // cost a connection pays after it comes up. Without a line here, a slow prefetch is invisible.
    log.debug(t("Reading the schemas on {0} from the driver's metadata", connectionLabel(request)));
    const result = await this.request<{ schemas: string[] }>(Methods.metadataSchemas, params);
    return result.schemas ?? [];
  }

  /** The `TABLE_TYPE` labels this driver uses, so callers can group without guessing. */
  async tableTypes(request: MetadataRequest): Promise<string[]> {
    const fromRule = await this.namesFromRule('tableTypes', request, {}, tableTypeFromRow, 'TABLE_TYPE');
    if (fromRule) {
      return fromRule;
    }

    log.debug(
      t("Reading the table types of {0} from the driver's metadata", connectionLabel(request)),
    );
    const result = await this.request<{ tableTypes: string[] }>(Methods.metadataTableTypes, {
      connectionId: request.connectionId,
    });
    return result.tableTypes ?? [];
  }

  async tables(request: TableRequest): Promise<DescribedTable[]> {
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

    log.debug(
      t(
        "Reading the tables of {0} on {1} from the driver's metadata",
        describeScope(subjectOf(request)),
        connectionLabel(request),
      ),
    );
    const result = await this.request<{ tables: TableInfo[] }>(Methods.metadataTables, params);
    return result.tables ?? [];
  }

  async columns(reference: TableReference): Promise<ColumnInfo[]> {
    const fromRule = await this.mappedFromRule('columns', reference, 'COLUMN_NAME', columnFromRow);
    if (fromRule) {
      return fromRule;
    }

    // Logged at debug because a tree expansion asks for these constantly, and the answer to "why is this
    // slow" is in the health report's timings rather than in a line per table. It is here for the other
    // question: whether the rule the user configured is being used at all.
    log.debug(
      t(
        "Reading the columns of {0} on {1} from the driver's metadata",
        subjectOf(reference),
        connectionLabel(reference),
      ),
    );
    const result = await this.request<{ columns: ColumnInfo[] }>(
      Methods.metadataColumns,
      withTable(reference),
    );
    return result.columns ?? [];
  }

  async indexes(reference: TableReference): Promise<IndexInfo[]> {
    const fromRule = await this.mappedFromRule('indexes', reference, 'INDEX_NAME', indexFromRow);
    if (fromRule) {
      return fromRule;
    }

    log.debug(
      t(
        "Reading the indexes of {0} on {1} from the driver's metadata",
        subjectOf(reference),
        connectionLabel(reference),
      ),
    );
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
        log.warn(t('Metadata query definition ignored: {0}', problem));
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
    run: RuleRun,
  ): Promise<MetadataResult | undefined> {
    const expanded = expandMetadataSql(rule.sql, values);
    if (expanded.missing.length > 0) {
      // Not run with the placeholder dropped: removing a filter changes which rows come back, not how
      // quickly, and a tree showing the wrong tables is worse than a slow one.
      this.reportOnce(
        `rule-missing-${rule.id}`,
        t(
          "The metadata query '{0}' uses {1}, which is not available for this read; the driver's metadata is used instead.",
          rule.id,
          expanded.missing.join(', '),
        ),
      );
      return undefined;
    }

    // Logged before it runs, like every other statement this extension issues. A rule is SQL the user
    // wrote but the extension chose and filled in, so "which statement actually ran" has to be answerable
    // from the output channel, and the placeholders are the reason: the statement in the settings is not
    // the statement that went to the database.
    log.info(
      t(
        "Running metadata query '{0}' for {1} on '{2}': {3}",
        rule.id,
        describeSubject(run.kind, run.scope),
        run.connection,
        summarizeSql(expanded.sql),
      ),
    );

    try {
      return await this.runQuery(connectionId, expanded.sql);
    } catch (error) {
      // A rule that does not work must not take the tree with it: the driver's metadata is slower, but it
      // is there, and a mistake in a SELECT is not a reason to show an empty database.
      this.reportOnce(
        `rule-failed-${rule.id}`,
        t(
          "The metadata query '{0}' failed ({1}); the driver's metadata is used instead.",
          rule.id,
          describeError(error),
        ),
      );
      return undefined;
    }
  }

  /**
   * Reads one table's columns or indexes with a rule, when one applies.
   *
   * The two are the same shape of read - one statement per table, one row per object - so they share a
   * path rather than diverging in the details: the name column they cannot do without, and what to say
   * when a rule returns rows that lack it.
   */
  private async mappedFromRule<T>(
    kind: 'columns' | 'indexes',
    reference: TableReference,
    nameColumn: string,
    mapRow: (row: MetadataRow, position: number) => T | undefined,
  ): Promise<T[] | undefined> {
    const rule = this.ruleFor(kind, reference.url);
    if (!rule) {
      return undefined;
    }

    const subject = { kind, scope: subjectOf(reference), connection: connectionLabel(reference) };
    const result = await this.runRule(
      rule,
      reference.connectionId,
      { catalog: reference.catalog, schema: reference.schema, table: reference.table },
      subject,
    );
    if (!result) {
      return undefined;
    }

    // The row's position is passed in as the ordinal, so a rule that did not select one still produces a
    // stable order - the order the statement returned, which the user is looking at.
    const mapped = result.rows
      .map((row, index) => mapRow(row, index + 1))
      .filter((object): object is T => object !== undefined);

    if (mapped.length === 0 && result.rows.length > 0) {
      this.reportOnce(
        `rule-columns-${rule.id}`,
        t(
          "The metadata query '{0}' returned rows but no {1} column, so it was ignored.",
          rule.id,
          nameColumn,
        ),
      );
      return undefined;
    }
    return mapped;
  }

  /** Runs a statement to completion and reads every row it returned, keyed by column name. */
  private async runQuery(connectionId: string, sql: string): Promise<MetadataResult> {
    const pageSize = METADATA_PAGE_SIZE;
    const first = await this.request<QueryExecuteResult>(Methods.queryExecute, {
      connectionId,
      sql,
      // A listing has to be complete: a tree that quietly stopped at the first page would look like a
      // database with fewer tables, which is the kind of wrong an index cannot survive.
      // Never: these rows become a tree or a completion list, neither of which shows a comment, and on a
      // slow driver the per-table metadata call would be the largest cost of the read.
      columnRemarks: false,
      maxRows: 0,
      pageSize,
      fetchSize: pageSize,
    });

    // Both spellings are kept: the upper-cased name keys the rows, and the original spelling is what the
    // user wrote in their SELECT, which is what the tree shows back to them as "other information".
    const columns = (first.columns ?? []).map((column) => column.name);
    const names = columns.map((name) => name.toUpperCase());
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

    return { columns, rows };
  }

  /**
   * Reads a list of names with a rule: the schemas, catalogs or table types of a connection.
   *
   * The three are the same shape - a statement, then a column of names - and they share a path for the same
   * reason the two per-table reads do: the alternative is three copies of the same four decisions (which
   * placeholder goes in, what to say when the name column is missing, whether to fall back).
   *
   * `values` is what the caller knows about the read; only a schema listing has anything to filter by, and
   * a rule for the other two that reaches for a placeholder is refused rather than run with it dropped.
   */
  private async namesFromRule(
    kind: 'schemas' | 'catalogs' | 'tableTypes',
    request: MetadataRequest,
    values: MetadataQueryValues,
    readName: (row: MetadataRow) => string | undefined,
    missingColumn: string,
  ): Promise<string[] | undefined> {
    const rule = this.ruleFor(kind, request.url);
    if (!rule) {
      return undefined;
    }

    // Named the way the health report names it - `schemas of shop` - so a line in the log and a row in the
    // report are recognisably about the same read.
    const scope = [values.catalog, values.schema, values.table]
      .filter((part): part is string => part !== undefined && part !== '')
      .join('.');
    const result = await this.runRule(rule, request.connectionId, values, {
      kind,
      scope,
      connection: connectionLabel(request),
    });
    if (!result) {
      return undefined;
    }

    const names = result.rows
      .map((row) => readName(row))
      .filter((name): name is string => name !== undefined && name !== '');

    if (names.length === 0 && result.rows.length > 0) {
      // Rows came back but no usable names: the rule is written against the wrong column names, which is
      // worth saying out loud rather than reporting as a database with no schemas.
      this.reportOnce(
        `rule-columns-${rule.id}`,
        t(
          "The metadata query '{0}' returned rows but no {1} column, so it was ignored.",
          rule.id,
          missingColumn,
        ),
      );
      return undefined;
    }
    // Deduplicated: these are lists the tree and the completion list key things by, and a rule that joins to
    // a second table easily returns the same name twice.
    return [...new Set(names)];
  }

  private async schemasFromRule(request: MetadataRequest): Promise<string[] | undefined> {
    return this.namesFromRule(
      'schemas',
      request,
      { catalog: request.catalog },
      schemaNameFromRow,
      'TABLE_SCHEM',
    );
  }

  private async tablesFromRule(request: TableRequest): Promise<DescribedTable[] | undefined> {
    const rule = this.ruleFor('tables', request.url);
    if (!rule) {
      return undefined;
    }

    const result = await this.runRule(
      rule,
      request.connectionId,
      {
        catalog: request.catalog,
        schema: request.schema,
        namePattern: request.namePattern,
      },
      {
        kind: 'tables',
        scope: request.schema || request.catalog || '',
        connection: connectionLabel(request),
      },
    );
    if (!result) {
      return undefined;
    }

    const described = result.rows
      .map((row) => tableFromRow(row, request, result.columns))
      .filter((table): table is DescribedTable => table !== undefined);
    if (described.length === 0 && result.rows.length > 0) {
      this.reportOnce(
        `rule-columns-${rule.id}`,
        t(
          "The metadata query '{0}' returned rows but no {1} column, so it was ignored.",
          rule.id,
          'TABLE_NAME',
        ),
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

/** How one read is named in the log and in the health report's metadata timings: `public.orders`. */
function subjectOf(reference: { schema?: string; table?: string }): string {
  return [reference.schema, reference.table]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('.');
}

/**
 * How a read names its connection in the log.
 *
 * The name the user chose where there is one, and the id otherwise: the id is at least something to search
 * the log for, and a line that hides which connection it was about cannot be acted on.
 */
function connectionLabel(request: { connectionId: string; connectionName?: string }): string {
  return request.connectionName ?? request.connectionId;
}

/** What a read was about when it named no object at all: the whole connection. */
function describeScope(scope: string): string {
  return scope === '' ? t('the connection') : scope;
}

/** What a rule run was about, in words: `columns of public.orders`. */
function describeSubject(kind: MetadataQueryKind, scope: string): string {
  return scope === ''
    ? kindLabel(kind)
    : t('{0} of {1}', kindLabel(kind), scope);
}

/**
 * The kind of read, in words.
 *
 * A switch rather than a table built at import time: `t` reads the locale, and the locale is set when the
 * extension activates - a table built while the module is first imported would freeze whichever language
 * happened to be current then.
 */
function kindLabel(kind: MetadataQueryKind): string {
  switch (kind) {
    case 'tables':
      return t('tables');
    case 'schemas':
      return t('schemas');
    case 'columns':
      return t('columns');
    case 'indexes':
      return t('indexes');
    case 'catalogs':
      return t('catalogs');
    case 'tableTypes':
      return t('table types');
  }
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
