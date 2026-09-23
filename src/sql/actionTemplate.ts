/**
 * Placeholder expansion for user-written SQL.
 *
 * Two features need this: custom actions in the tree, and the statement used to fetch a table's DDL.
 * They differ in what a name means, which is why the placeholders say so explicitly:
 *
 * - the raw and `quoted` forms are separate names rather than one name with a clever default, because
 *   the right spelling depends on where the name lands. `FROM` wants it quoted; a string literal passed
 *   to `pg_get_tabledef('...')` must not be, and Hive's `DESC` usually takes it bare. Guessing produces
 *   SQL that runs and finds nothing.
 * - an unknown or unavailable `${...}` is left in place rather than blanked, so a mistake is visible in
 *   the editor instead of turning into a query against the empty string.
 *
 * Kept free of `vscode` so the rules can be tested directly.
 */

/** Where an action is offered. */
export type ActionTarget = 'table' | 'view' | 'column';

export interface ActionDefinition {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  /** Which nodes the action is offered for. Absent means every table-like node. */
  readonly appliesTo?: readonly ActionTarget[];
  readonly sql: string;
}

/** The values a template may refer to. */
export interface ActionContext {
  /** Names exactly as the driver reported them. */
  readonly table: string;
  readonly schema: string;
  readonly catalog: string;
  /** `schema.table`, or just the table when there is no schema. */
  readonly qualified: string;

  /**
   * Only present when the action was invoked on a column.
   *
   * Absent rather than empty on purpose: a template using `${column}` on a table must be refused, not
   * expanded to nothing. `WHERE x = ` is a syntax error, but `LIKE '%${column}%'` quietly matches
   * everything, and a wrong answer is worse than a refusal.
   */
  readonly column?: string;

  /** The same names wrapped in the quoting character the database reported. */
  readonly quotedTable: string;
  readonly quotedSchema: string;
  readonly quotedCatalog: string;
  readonly quotedQualified: string;
  readonly quotedColumn?: string;

  readonly connectionName: string;
}

/** The placeholders a template may use. Documented in the settings that expose templates. */
export const ACTION_PLACEHOLDERS = [
  '${table}',
  '${schema}',
  '${catalog}',
  '${qualified}',
  '${column}',
  '${quotedTable}',
  '${quotedSchema}',
  '${quotedCatalog}',
  '${quotedQualified}',
  '${quotedColumn}',
  '${connectionName}',
] as const;

export interface ActionContextInput {
  readonly catalog?: string;
  readonly schema?: string;
  readonly table: string;
  readonly column?: string;
  readonly connectionName: string;
  /** The quote character the database reported, or undefined when it cannot quote. */
  readonly quote: string | undefined;
}

/** Quotes one identifier the way the database asks, doubling any embedded quote character. */
function quoteName(name: string, quote: string | undefined): string {
  if (!quote || name === '') {
    return name;
  }
  return quote + name.split(quote).join(quote + quote) + quote;
}

/** Builds the values a template may refer to. */
export function buildActionContext(input: ActionContextInput): ActionContext {
  const catalog = input.catalog ?? '';
  const schema = input.schema ?? '';
  const parts = [schema, input.table].filter((part) => part !== '');
  const column = input.column ?? '';

  const context: ActionContext = {
    table: input.table,
    schema,
    catalog,
    qualified: parts.join('.'),
    quotedTable: quoteName(input.table, input.quote),
    quotedSchema: quoteName(schema, input.quote),
    quotedCatalog: quoteName(catalog, input.quote),
    quotedQualified: parts.map((part) => quoteName(part, input.quote)).join('.'),
    connectionName: input.connectionName,
  };

  if (column === '') {
    return context;
  }
  return { ...context, column, quotedColumn: quoteName(column, input.quote) };
}

const TARGETS: readonly ActionTarget[] = ['table', 'view', 'column'];

/**
 * Reads action definitions out of the setting value.
 *
 * Entries that cannot work are dropped rather than raising: the setting is a list the user edits by
 * hand, and one bad entry must not take the others with it. A dropped entry is reported to the caller
 * so it can be mentioned in the log.
 */
export function parseActions(raw: unknown): { actions: ActionDefinition[]; problems: string[] } {
  const actions: ActionDefinition[] = [];
  const problems: string[] = [];

  if (raw === undefined || raw === null) {
    return { actions, problems };
  }
  if (!Array.isArray(raw)) {
    return { actions, problems: ['The actions setting must be a list.'] };
  }

  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const where = `entry ${index + 1}`;
    if (typeof entry !== 'object' || entry === null) {
      problems.push(`${where} is not an object.`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    const sql = typeof record.sql === 'string' ? record.sql : '';

    if (id === '') {
      problems.push(`${where} has no id.`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`${where} reuses the id '${id}'.`);
      continue;
    }
    if (label === '') {
      problems.push(`'${id}' has no label.`);
      continue;
    }
    if (sql.trim() === '') {
      problems.push(`'${id}' has no SQL.`);
      continue;
    }

    seen.add(id);
    actions.push({
      id,
      label,
      sql,
      description: typeof record.description === 'string' ? record.description : undefined,
      icon: typeof record.icon === 'string' ? record.icon : undefined,
      appliesTo: parseTargets(record.appliesTo, id, problems),
    });
  }

  return { actions, problems };
}

function parseTargets(
  raw: unknown,
  id: string,
  problems: string[],
): readonly ActionTarget[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    problems.push(`'${id}' has an appliesTo that is not a list; the action will be offered everywhere.`);
    return undefined;
  }
  const targets = raw.filter(
    (value): value is ActionTarget => typeof value === 'string' && TARGETS.includes(value as ActionTarget),
  );
  const ignored = raw.filter((value) => !targets.includes(value as ActionTarget));
  if (ignored.length > 0) {
    problems.push(
      `'${id}' lists ${ignored.map((value) => JSON.stringify(value)).join(', ')}, ` +
        `which is not one of ${TARGETS.join(', ')}.`,
    );
  }
  return targets.length > 0 ? targets : undefined;
}

/** Whether an action should be offered for a node. */
export function appliesTo(action: ActionDefinition, target: ActionTarget): boolean {
  return action.appliesTo === undefined || action.appliesTo.includes(target);
}

/**
 * Expands a template.
 *
 * An unknown `${...}` is left untouched rather than blanked, so a typo shows up in the editor as
 * something obviously wrong instead of as a query that quietly searches for the empty string.
 * `${column}` on a table is left in place for the same reason - it is meant to be used by an action
 * offered on a column.
 */
export function expandAction(sql: string, context: ActionContext): string {
  return sql.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const value = (context as unknown as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : match;
  });
}

/** The placeholders in a template that this context cannot fill. */
export function unresolvedPlaceholders(sql: string, context: ActionContext): string[] {
  const missing = new Set<string>();
  for (const match of sql.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const name = match[1];
    const value = (context as unknown as Record<string, unknown>)[name];
    if (typeof value !== 'string') {
      missing.add(`\${${name}}`);
    }
  }
  return [...missing];
}

// ---------------------------------------------------------------------------
// DDL queries
// ---------------------------------------------------------------------------

/**
 * How to ask a particular database for a table's DDL.
 *
 * Reconstructing a `CREATE TABLE` from JDBC metadata only goes so far: it cannot see storage clauses,
 * tablespaces or engine options, and it cannot know about types the driver reports as `OTHER`. Many
 * databases already answer the question directly, and the answer is better than anything that could be
 * reassembled - `SHOW CREATE TABLE` on MySQL, `DESC` on Hive, `pg_get_tabledef` on PostgreSQL. Those
 * statements are dialect-specific, which is precisely why the user writes them and the extension only
 * runs them and shows what came back.
 */
export interface DdlQuery {
  readonly id: string;
  /**
   * Glob tested against the connection's JDBC URL, where `*` matches any run of characters.
   *
   * Absent means every connection. Matched case-insensitively against the whole URL, so
   * `jdbc:hive2:*` selects Hive and `jdbc:postgresql:*` selects PostgreSQL.
   */
  readonly match?: string;
  readonly sql: string;
}

/** Reads DDL query rules out of the setting value, dropping entries that cannot work. */
export function parseDdlQueries(raw: unknown): { queries: DdlQuery[]; problems: string[] } {
  const queries: DdlQuery[] = [];
  const problems: string[] = [];

  if (raw === undefined || raw === null) {
    return { queries, problems };
  }
  if (!Array.isArray(raw)) {
    return { queries, problems: ['The DDL queries setting must be a list.'] };
  }

  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const where = `entry ${index + 1}`;
    if (typeof entry !== 'object' || entry === null) {
      problems.push(`${where} is not an object.`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const sql = typeof record.sql === 'string' ? record.sql : '';
    if (sql.trim() === '') {
      problems.push(`${where} has no SQL.`);
      continue;
    }

    // An id is only needed to tell two rules apart in a message, so one is generated when it is absent
    // rather than rejecting a rule that is otherwise usable.
    const declared = typeof record.id === 'string' ? record.id.trim() : '';
    const id = declared === '' ? `ddl-${index + 1}` : declared;
    if (seen.has(id)) {
      problems.push(`${where} reuses the id '${id}'.`);
      continue;
    }

    const match = typeof record.match === 'string' ? record.match.trim() : '';
    seen.add(id);
    queries.push({ id, sql, match: match === '' ? undefined : match });
  }

  return { queries, problems };
}

/** Turns a glob into an anchored, case-insensitive pattern. Only `*` is special. */
export function globToRegExp(glob: string): RegExp {
  // Everything that means something to a regular expression is escaped; `*` is replaced by a marker so
  // it survives that escaping, then turned into the wildcard.
  const marker = '\u0000';
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === '*' ? marker : `\\${char}`));
  return new RegExp(`^${escaped.split(marker).join('.*')}$`, 'i');
}

/**
 * The rule that applies to a connection, or undefined to use the built-in generator.
 *
 * The first match in document order wins, so a broad rule placed after a narrow one acts as a
 * fallback - the only ordering anybody expects from a list like this.
 */
export function matchDdlQuery(url: string, queries: readonly DdlQuery[]): DdlQuery | undefined {
  return queries.find((query) => query.match === undefined || globToRegExp(query.match).test(url));
}
