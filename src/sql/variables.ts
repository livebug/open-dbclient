/**
 * Parameter substitution for SQL scripts.
 *
 * The work is split out from the service that stores the values so the parsing rules can be tested
 * without an editor: a substitution that silently does nothing looks exactly like a query that
 * returned the wrong thing, and that is a bad thing to ship untested.
 */

/**
 * The default spelling: `${NAME}`, with optional spaces inside the braces.
 *
 * Deliberately not `:NAME` or `@NAME` - those collide with identifiers and with bind-parameter syntax
 * in various databases, and the whole point of this project is to stay out of dialect territory.
 */
export const DEFAULT_VARIABLE_PATTERN = '\\$\\{\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\}';

/** Compiles the configured pattern, or returns undefined when it is unusable. */
export function compilePattern(source: string): RegExp | undefined {
  if (source.trim() === '') {
    return undefined;
  }
  try {
    // Global so that every occurrence is found; the pattern is documented as needing one group.
    return new RegExp(source, 'g');
  } catch {
    return undefined;
  }
}

/**
 * The variable names referenced by a script, in the order they first appear, without duplicates.
 *
 * Order matters: the panel lists them in the order the reader meets them in the file.
 */
export function variableNames(text: string, pattern: RegExp | undefined): string[] {
  if (!pattern) {
    return [];
  }
  const seen = new Set<string>();
  const names: string[] = [];
  // A fresh lastIndex, because a global regex carries its position between calls.
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const name = match[1] ?? match[0];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export interface SubstitutionResult {
  /** The text with every variable that has a value replaced. */
  readonly sql: string;
  /** Names that appear in the text but have no value. Their placeholders are left untouched. */
  readonly missing: string[];
}

/**
 * Replaces every variable that has a value.
 *
 * Placeholders without a value are left in the text rather than replaced by an empty string, and
 * their names are reported. Sending `WHERE created_at > ''` to a database because a value was missing
 * would be worse than refusing to run.
 */
export function substitute(
  text: string,
  pattern: RegExp | undefined,
  values: ReadonlyMap<string, string>,
): SubstitutionResult {
  if (!pattern) {
    return { sql: text, missing: [] };
  }

  const missing = new Set<string>();
  pattern.lastIndex = 0;
  const sql = text.replace(pattern, (match, ...rest) => {
    // With one capture group the callback receives (match, group, offset, string); a pattern with no
    // group leaves the whole match as the name, which is the only sensible reading of it.
    const captured = rest[0];
    const name = typeof captured === 'string' ? captured : match;
    const value = values.get(name);
    if (value === undefined || value === '') {
      missing.add(name);
      return match;
    }
    return value;
  });

  return { sql, missing: [...missing] };
}
