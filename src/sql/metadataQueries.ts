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

/** Which metadata read a rule replaces. */
export type MetadataQueryKind = 'schemas' | 'tables';

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
    if (kind !== 'schemas' && kind !== 'tables') {
      // Rejected rather than defaulted: a rule written for the wrong read would return rows of the wrong
      // shape, and the tree would show nonsense instead of reporting a typo.
      problems.push(`${where} has no usable kind; expected 'schemas' or 'tables'.`);
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
    queries.push({ id, kind, sql, match: match === '' ? undefined : match });
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
    case 'namePattern':
      // An absent pattern means "everything", and `%` says exactly that. Treating it as missing would
      // make every rule unusable from the tree, which never passes a pattern for a plain listing.
      return values.namePattern ?? '%';
    default:
      return undefined;
  }
}

/**
 * The example rules the install command offers.
 *
 * PostgreSQL and the drivers that keep its catalogs. `information_schema` is the standard spelling and
 * `pg_catalog` the fast one; the rules use `information_schema` because it is what a user can check by
 * hand, and any database that answers it will answer it far faster than the driver's
 * `getColumns`-equivalent does.
 *
 * They are offered rather than defaulted into the setting: switching the source of every tree on every
 * PostgreSQL connection is a large change to make on somebody's behalf, and one they should be able to
 * see before it happens.
 */
export function metadataQueryExamples(): MetadataQuery[] {
  return [
    {
      id: 'postgres-tables',
      kind: 'tables',
      match: 'jdbc:postgresql:*',
      sql:
        `SELECT table_schema AS TABLE_SCHEM,\n` +
        `       table_name   AS TABLE_NAME,\n` +
        `       table_type   AS TABLE_TYPE\n` +
        `  FROM information_schema.tables\n` +
        ` WHERE table_schema = '\${schema}'`,
    },
    {
      id: 'postgres-schemas',
      kind: 'schemas',
      match: 'jdbc:postgresql:*',
      sql:
        `SELECT schema_name AS TABLE_SCHEM\n` +
        `  FROM information_schema.schemata\n` +
        ` ORDER BY schema_name`,
    },
    {
      id: 'opengauss-tables',
      kind: 'tables',
      match: 'jdbc:opengauss:*',
      sql:
        `SELECT table_schema AS TABLE_SCHEM,\n` +
        `       table_name   AS TABLE_NAME,\n` +
        `       table_type   AS TABLE_TYPE\n` +
        `  FROM information_schema.tables\n` +
        ` WHERE table_schema = '\${schema}'`,
    },
    {
      id: 'opengauss-schemas',
      kind: 'schemas',
      match: 'jdbc:opengauss:*',
      sql:
        `SELECT schema_name AS TABLE_SCHEM\n` +
        `  FROM information_schema.schemata\n` +
        ` ORDER BY schema_name`,
    },
  ];
}
