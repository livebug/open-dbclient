/**
 * User-defined SQL actions for the connection tree.
 *
 * The tree's built-in "Select Top 200 Rows" is fixed in code, so anything else a user runs regularly -
 * counting rows, looking at the last week, checking for nulls - has to be retyped every time. These
 * definitions turn that into a named action.
 *
 * Kept free of `vscode` so the substitution rules can be tested directly. A placeholder that silently
 * expands to nothing produces SQL that runs and returns the wrong rows, which is worse than an error.
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
  /** Table or view name, quoted for the database. */
  readonly table: string;
  readonly schema: string;
  readonly catalog: string;
  /** `schema.table`, or just the table when there is no schema. */
  readonly qualifiedTable: string;
  readonly connectionName: string;
  /** Column name, quoted. Only meaningful for actions offered on a column. */
  readonly column?: string;
}

/** The placeholders a template may use, for the error message and for documentation. */
export const ACTION_PLACEHOLDERS = [
  '${table}',
  '${schema}',
  '${catalog}',
  '${qualifiedTable}',
  '${connectionName}',
  '${column}',
] as const;

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
