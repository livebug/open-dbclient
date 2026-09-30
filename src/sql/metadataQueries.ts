/**
 * User-written SQL for the reads behind the connection tree.
 *
 * <h2>Why this exists</h2>
 *
 * The tree lists schemas and tables through `DatabaseMetaData`, which is the only approach that works
 * without knowing the database. It is also, on some drivers, extremely slow: `getColumns` and
 * `getTables` are implemented as large catalog queries, and on databases that inherit a PostgreSQL
 * catalogs layout through a different driver the result can take minutes where the equivalent SQL
 * returns in milliseconds.
 *
 * So the same trade the DDL queries make is offered here: the user, who knows their database, writes
 * the statement; the extension runs it and reads the answer. No matching rule means the driver's own
 * metadata is used, which is what keeps the default behaviour unchanged.
 *
 * <h2>The contract</h2>
 *
 * The statement may use `${catalog}`, `${schema}` and `${namePattern}` — the last being the LIKE
 * pattern the tree was asked for. A rule whose placeholders cannot be filled is not used at all:
 * sending a query with a filter silently dropped would return the wrong rows, and a wrong tree is
 * worse than a slow one.
 *
 * The result is read by column name, matched case-insensitively, using the names JDBC itself uses for
 * the same data - `TABLE_SCHEM`, `TABLE_NAME`, `TABLE_TYPE`, `REMARKS`. That naming is the whole
 * documentation: anyone who has read a `DatabaseMetaData` result set already knows it, and anyone who
 * has not can alias their columns to match.
 */

/**
 * The columns accepted as a table's comment - the name it is known by in the user's own vocabulary.
 *
 * Three spellings rather than one, because the three catalog views a rule is realistically written
 * against disagree: JDBC calls it `REMARKS`, `information_schema.tables` on MySQL calls it
 * `TABLE_COMMENT`, and hand-written statements often alias it `COMMENT`. Accepting all three costs a
 * lookup each and saves every user from discovering the list by trial and error.
 */
export const TABLE_REMARK_COLUMNS: readonly string[] = ['REMARKS', 'TABLE_COMMENT', 'COMMENT'];

/**
 * The result columns that belong to the contract, in the names JDBC uses for the same data.
 *
 * Every other column a rule returns becomes the table's "other information" and is shown in the tree's
 * tooltip - which is what makes this extensible without an extension release per database.
 */
export const TABLE_RESERVED_COLUMNS: readonly string[] = [
  'TABLE_NAME',
  'TABLE_SCHEM',
  'SCHEMA_NAME',
  'TABLE_CAT',
  'TABLE_CATALOG',
  'TABLE_TYPE',
  ...TABLE_REMARK_COLUMNS,
];

/**
 * The result columns that are not part of the contract, in the order the statement returned them.
 *
 * Order is kept because the user chose it: a rule that selects the comment before the row count is
 * asking for them to be read in that order, and re-sorting into a map would lose that intent.
 */
export function otherColumns(columns: readonly string[]): string[] {
  const reserved = new Set(TABLE_RESERVED_COLUMNS);
  // Named columns only: a driver that did not name one of its result columns leaves an empty entry here,
  // and "": "12" is not information about the table.
  return columns.filter((name) => name.trim() !== '' && !reserved.has(name.toUpperCase()));
}

/**
 * Which metadata read a rule replaces.
 *
 * `columns` and `indexes` matter most in practice, because they are the reads that happen per table:
 * expanding a table in the tree, the completion cache filling itself, or a "Show Columns" pays for each
 * one separately, and on a driver whose `getColumns` is a large catalog query that is the whole cost of
 * using the tree. `schemas` and `tables` are read once per expansion, and `tables` is the one that is
 * slow on a database with thousands of them.
 */
export type MetadataQueryKind = 'schemas' | 'tables' | 'columns' | 'indexes';

/** Every kind, for validating the setting and for the message that rejects a typo. */
export const METADATA_QUERY_KINDS: readonly MetadataQueryKind[] = [
  'schemas',
  'tables',
  'columns',
  'indexes',
];

export interface MetadataQuery {
  readonly id: string;
  readonly kind: MetadataQueryKind;
  /**
   * Glob tested against the connection's JDBC URL, where `*` matches any run of characters.
   *
   * Absent means every connection. Matched case-insensitively against the whole URL, so
   * `jdbc:postgresql:*` selects PostgreSQL and `jdbc:opengauss:*` an openGauss-compatible driver.
   */
  readonly match?: string;
  readonly sql: string;
}

/** The placeholders a rule may use, as the values the caller has at hand. */
export interface MetadataQueryValues {
  readonly catalog?: string;
  readonly schema?: string;
  /** Set for the reads that are about one table: `columns` and `indexes`. */
  readonly table?: string;
  readonly namePattern?: string;
}

const PLACEHOLDER = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;

/** Reads metadata query rules out of the setting value, dropping entries that cannot work. */
export function parseMetadataQueries(raw: unknown): { queries: MetadataQuery[]; problems: string[] } {
  const queries: MetadataQuery[] = [];
  const problems: string[] = [];

  if (raw === undefined || raw === null) {
    return { queries, problems };
  }
  if (!Array.isArray(raw)) {
    return { queries, problems: ['The metadata queries setting must be a list.'] };
  }

  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const where = `entry ${index + 1}`;
    if (typeof entry !== 'object' || entry === null) {
      problems.push(`${where} is not an object.`);
      continue;
    }
    const record = entry as Record<string, unknown>;

    const kind = typeof record.kind === 'string' ? record.kind.trim().toLowerCase() : '';
    if (!METADATA_QUERY_KINDS.includes(kind as MetadataQueryKind)) {
      // Rejected rather than defaulted: a rule written for the wrong read would return rows of the wrong
      // shape, and the tree would show nonsense instead of reporting a typo.
      problems.push(
        `${where} has no usable kind; expected one of ${METADATA_QUERY_KINDS.map((name) => `'${name}'`).join(', ')}.`,
      );
      continue;
    }

    const sql = typeof record.sql === 'string' ? record.sql : '';
    if (sql.trim() === '') {
      problems.push(`${where} has no SQL.`);
      continue;
    }

    const declared = typeof record.id === 'string' ? record.id.trim() : '';
    const id = declared === '' ? `${kind}-${index + 1}` : declared;
    if (seen.has(id)) {
      problems.push(`${where} reuses the id '${id}'.`);
      continue;
    }

    const match = typeof record.match === 'string' ? record.match.trim() : '';
    seen.add(id);
    queries.push({ id, kind: kind as MetadataQueryKind, sql, match: match === '' ? undefined : match });
  }

  return { queries, problems };
}

/**
 * The rule to use for one read, or undefined to use the driver's metadata.
 *
 * The first rule of the right kind whose `match` fits wins, in document order, so a broad rule placed
 * last acts as a fallback - the only ordering anybody expects from a list like this.
 */
export function matchMetadataQuery(
  kind: MetadataQueryKind,
  url: string,
  queries: readonly MetadataQuery[],
  isMatch: (glob: string, url: string) => boolean,
): MetadataQuery | undefined {
  return queries.find(
    (query) => query.kind === kind && (query.match === undefined || isMatch(query.match, url)),
  );
}

/**
 * Fills the placeholders a rule may use.
 *
 * @returns the statement, plus the names of any placeholders with no value - in which case the caller
 *          must not run it, because dropping a filter changes which rows come back rather than how
 *          quickly they do.
 */
export function expandMetadataSql(
  sql: string,
  values: MetadataQueryValues,
): { sql: string; missing: string[] } {
  const missing = new Set<string>();
  const expanded = sql.replace(PLACEHOLDER, (whole, name: string) => {
    const value = valueOf(name, values);
    if (value === undefined) {
      missing.add(name);
      return whole;
    }
    // Raw, unquoted: these go inside string literals in the user's statement, and a quoted identifier
    // there would look for a name that contains the quoting character.
    return value;
  });
  return { sql: expanded, missing: [...missing] };
}

function valueOf(name: string, values: MetadataQueryValues): string | undefined {
  switch (name) {
    case 'catalog':
      return values.catalog;
    case 'schema':
      return values.schema;
    case 'table':
      return values.table;
    case 'namePattern':
      // An absent pattern means "everything", and `%` says exactly that. Treating it as missing would
      // make every rule unusable from the tree, which never passes a pattern for a plain listing.
      return values.namePattern ?? '%';
    // The literal forms carry their own single quotes, because that is where these values usually land:
    // `WHERE table_name = '${table}'` is not a statement anybody can write safely by hand once a name
    // contains a quote, and the one that fixes it is the one that owns the value. A template using them
    // has no quotes of its own to get wrong.
    case 'catalogLiteral':
      return literal(values.catalog);
    case 'schemaLiteral':
      return literal(values.schema);
    case 'tableLiteral':
      return literal(values.table);
    case 'namePatternLiteral':
      return literal(values.namePattern ?? '%');
    default:
      return undefined;
  }
}

function literal(value: string | undefined): string | undefined {
  return value === undefined ? undefined : `'${value.replace(/'/g, "''")}'`;
}

/**
 * The example rules the install command offers.
 *
 * PostgreSQL (and the databases that keep its catalogs) plus MySQL, which is the pair that covers what
 * most people are running. The PostgreSQL rules read `pg_catalog` rather than `information_schema` for
 * two reasons: it is dramatically faster on a large catalog, and it is the only one of the two that can
 * reach the table's comment, which lives in `pg_description` and is what a Chinese schema usually uses as
 * the table's real name.
 *
 * They are offered rather than defaulted into the setting: switching the source of every tree on every
 * PostgreSQL connection is a large change to make on somebody's behalf, and one they should be able to
 * see before it happens. The extra column in the PostgreSQL example is deliberate as well - it is an
 * illustration that a rule may return anything and the tree will show it.
 *
 * The `columns` rules are the ones most likely to be adopted, because that read happens once per table
 * and is what makes expanding a table slow. Both of them return the primary key and the comment, which
 * are the two things the tree shows beyond the name and type, and both use the literal placeholders -
 * a table name is data, and a rule that pastes it into quotes by hand breaks on a name containing one.
 *
 * The PostgreSQL index read is not example'd: enumerating the columns of an index needs `unnest ...
 * WITH ORDINALITY` or a `LATERAL`, and those are recent enough that shipping them as the example would
 * break exactly the older PostgreSQL-compatible databases this feature is for. The MySQL one is a
 * single view.
 */
export function metadataQueryExamples(): MetadataQuery[] {
  return [
    {
      id: 'postgres-tables',
      kind: 'tables',
      match: 'jdbc:postgresql:*',
      sql: postgresTablesSql(),
    },
    {
      id: 'postgres-schemas',
      kind: 'schemas',
      match: 'jdbc:postgresql:*',
      sql: postgresSchemasSql(),
    },
    {
      id: 'postgres-columns',
      kind: 'columns',
      match: 'jdbc:postgresql:*',
      sql: postgresColumnsSql(),
    },
    {
      id: 'opengauss-tables',
      kind: 'tables',
      // openGauss keeps the PostgreSQL catalogs, and its own driver's metadata calls are the ones this
      // feature was written for.
      match: 'jdbc:opengauss:*',
      sql: postgresTablesSql(),
    },
    {
      id: 'opengauss-schemas',
      kind: 'schemas',
      match: 'jdbc:opengauss:*',
      sql: postgresSchemasSql(),
    },
    {
      id: 'opengauss-columns',
      kind: 'columns',
      match: 'jdbc:opengauss:*',
      sql: postgresColumnsSql(),
    },
    {
      id: 'mysql-tables',
      kind: 'tables',
      match: 'jdbc:mysql:*',
      sql:
        `SELECT table_schema  AS TABLE_SCHEM,\n` +
        `       table_name    AS TABLE_NAME,\n` +
        `       table_type    AS TABLE_TYPE,\n` +
        `       table_comment AS REMARKS,\n` +
        `       engine        AS ENGINE,\n` +
        `       table_rows    AS EST_ROWS\n` +
        `  FROM information_schema.tables\n` +
        ` WHERE table_schema = '\${schema}'\n` +
        ` ORDER BY table_name`,
    },
    {
      id: 'mysql-schemas',
      kind: 'schemas',
      match: 'jdbc:mysql:*',
      sql:
        `SELECT schema_name AS TABLE_SCHEM\n` +
        `  FROM information_schema.schemata\n` +
        ` ORDER BY schema_name`,
    },
    {
      id: 'mysql-columns',
      kind: 'columns',
      match: 'jdbc:mysql:*',
      sql:
        `SELECT column_name      AS COLUMN_NAME,\n` +
        `       column_type      AS TYPE_NAME,\n` +
        `       ordinal_position AS ORDINAL_POSITION,\n` +
        `       is_nullable      AS IS_NULLABLE,\n` +
        `       column_default   AS COLUMN_DEF,\n` +
        `       column_comment   AS REMARKS,\n` +
        `       (column_key = 'PRI')               AS IS_PRIMARY_KEY,\n` +
        `       (extra LIKE '%auto_increment%')    AS IS_AUTOINCREMENT,\n` +
        `       (extra LIKE '%GENERATED%')         AS IS_GENERATEDCOLUMN\n` +
        `  FROM information_schema.columns\n` +
        ` WHERE table_schema = \${schemaLiteral}\n` +
        `   AND table_name = \${tableLiteral}\n` +
        ` ORDER BY ordinal_position`,
    },
    {
      id: 'mysql-indexes',
      kind: 'indexes',
      match: 'jdbc:mysql:*',
      sql:
        `SELECT index_name        AS INDEX_NAME,\n` +
        `       (non_unique <> 0)  AS NON_UNIQUE,\n` +
        `       column_name       AS COLUMN_NAME,\n` +
        `       seq_in_index      AS ORDINAL_POSITION,\n` +
        `       index_type        AS TYPE_NAME\n` +
        `  FROM information_schema.statistics\n` +
        ` WHERE table_schema = \${schemaLiteral}\n` +
        `   AND table_name = \${tableLiteral}\n` +
        ` ORDER BY index_name, seq_in_index`,
    },
  ];
}

/**
 * `reltuples` is an estimate the planner keeps in the catalog, so reading it costs nothing - which is the
 * point of the example. `obj_description` is what carries the comment on PostgreSQL.
 */
function postgresTablesSql(): string {
  return (
    `SELECT n.nspname AS TABLE_SCHEM,\n` +
    `       c.relname AS TABLE_NAME,\n` +
    `       CASE c.relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE' WHEN 'v' THEN 'VIEW'\n` +
    `                      WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE'\n` +
    `                      ELSE 'TABLE' END AS TABLE_TYPE,\n` +
    `       pg_catalog.obj_description(c.oid, 'pg_class') AS REMARKS,\n` +
    `       c.reltuples::bigint AS EST_ROWS\n` +
    `  FROM pg_catalog.pg_class c\n` +
    `  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\n` +
    ` WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')\n` +
    `   AND n.nspname = '\${schema}'\n` +
    ` ORDER BY c.relname`
  );
}

/** System schemas are left out because a tree is for reading, and nobody browses `pg_toast`. */
function postgresSchemasSql(): string {
  return (
    `SELECT nspname AS TABLE_SCHEM\n` +
    `  FROM pg_catalog.pg_namespace\n` +
    ` WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')\n` +
    ` ORDER BY nspname`
  );
}

/**
 * `format_type` renders the type the way the database itself prints it - `character varying(20)` - so the
 * tree shows the length without this extension having to decide where a length belongs.
 *
 * The pivot table `pg_attribute` and the two lookups through it are what make this fast: the catalogs are
 * indexed by object id, where `information_schema.columns` is a set of views over the same thing.
 */
function postgresColumnsSql(): string {
  return (
    `SELECT a.attname AS COLUMN_NAME,\n` +
    `       pg_catalog.format_type(a.atttypid, a.atttypmod) AS TYPE_NAME,\n` +
    `       a.attnum AS ORDINAL_POSITION,\n` +
    `       NOT a.attnotnull AS IS_NULLABLE,\n` +
    `       pg_catalog.col_description(a.attrelid, a.attnum) AS REMARKS,\n` +
    `       pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS COLUMN_DEF,\n` +
    `       EXISTS (SELECT 1 FROM pg_catalog.pg_index i\n` +
    `                WHERE i.indrelid = a.attrelid AND i.indisprimary\n` +
    `                  AND a.attnum = ANY (i.indkey)) AS IS_PRIMARY_KEY,\n` +
    `       pg_catalog.pg_get_serial_sequence(\n` +
    `         pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname),\n` +
    `         a.attname) IS NOT NULL AS IS_AUTOINCREMENT\n` +
    `  FROM pg_catalog.pg_attribute a\n` +
    `  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid\n` +
    `  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\n` +
    `  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum\n` +
    ` WHERE n.nspname = \${schemaLiteral}\n` +
    `   AND c.relname = \${tableLiteral}\n` +
    `   AND a.attnum > 0\n` +
    `   AND NOT a.attisdropped\n` +
    ` ORDER BY a.attnum`
  );
}
