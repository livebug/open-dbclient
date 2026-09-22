/**
 * Works out what the user is most likely to want to complete at a given position.
 *
 * This is a scanner, not a parser, and that is deliberate. A parser needs valid input; a completion
 * request almost never has it, because the cursor sits in the middle of a statement the user is still
 * writing. `SELECT * FROM us|` is not parseable, yet it is precisely when completion matters.
 *
 * The approach is therefore local and forgiving: tokenise up to the cursor, notice whether the cursor
 * is inside a literal or comment, then walk backwards to the nearest clause keyword to decide whether
 * tables or columns are wanted. Backwards scanning to the nearest keyword also gets nested cases
 * right for free, so `... WHERE id IN (SELECT id FROM |)` suggests tables, because `FROM` is nearer
 * than the `WHERE`.
 */

/** What the position calls for. */
export type CompletionTarget = 'table' | 'column' | 'none';

/** A table named in a statement, with whatever alias it was given. */
export interface TableReference {
  readonly name: string;
  /** Alias, which may differ in case from the table name. */
  readonly alias?: string;
}

/** The analysis of one cursor position. */
export interface SqlContext {
  readonly target: CompletionTarget;
  /** Word fragment immediately before the cursor, used to filter candidates. */
  readonly prefix: string;
  /** Qualifier from a dotted reference, e.g. the `u` in `u.na|`. */
  readonly qualifier?: string;
  /** Tables named in the enclosing statement, used to scope column suggestions. */
  readonly references: readonly TableReference[];
  /** Offset where the word being completed starts, so the provider replaces exactly that word. */
  readonly replaceStart: number;
}

/**
 * Keywords after which a table name is expected.
 *
 * Only keywords whose next token is genuinely a table being read or written. `DELETE` is absent
 * because `DELETE FROM` puts `FROM` in between, and `TABLE` is absent because `CREATE TABLE x` names
 * a table that does not exist yet - counting it would attribute the new table's name as a reference
 * and offer that table's columns everywhere in its own definition.
 */
const TABLE_REFERENCE_KEYWORDS = new Set(['from', 'join', 'into', 'update', 'using']);

/**
 * Keywords that suggest an existing table name is wanted.
 *
 * A superset of the reference keywords, plus `TABLE`, because `DROP TABLE` and `ALTER TABLE` are
 * followed by the name of a table that already exists and is worth offering.
 */
const TABLE_COMPLETION_KEYWORDS = new Set([...TABLE_REFERENCE_KEYWORDS, 'table']);

/**
 * Keywords after which a column expression is expected.
 *
 * `AND` and `OR` are included because they almost always follow a column comparison, and `BY` covers
 * both `GROUP BY` and `ORDER BY`.
 */
const COLUMN_KEYWORDS = new Set([
  'select',
  'where',
  'on',
  'and',
  'or',
  'not',
  'having',
  'set',
  'by',
  'values',
  'when',
  'then',
  'else',
  'case',
  'end',
  'returning',
  'distinct',
  'as',
]);

/** Words that cannot be an alias, so a following word must be a new clause instead. */
const NON_ALIAS_WORDS = new Set([
  ...TABLE_COMPLETION_KEYWORDS,
  ...COLUMN_KEYWORDS,
  'where',
  'group',
  'order',
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
  'left',
  'right',
  'inner',
  'outer',
  'full',
  'cross',
  'natural',
  'window',
  'fetch',
  'for',
  'with',
]);

interface Token {
  readonly kind: 'word' | 'number' | 'punct' | 'quoted' | 'comment';
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Analyses the position, using the whole document for context. */
export function analyzeSqlContext(sql: string, offset: number): SqlContext {
  const clamped = Math.max(0, Math.min(offset, sql.length));
  const tokens = tokenize(sql, 0, clamped);
  const statementStart = findStatementStart(sql, clamped);
  const references = referencedTables(sql.slice(statementStart, clamped), statementStart);

  const last = tokens[tokens.length - 1];

  // A cursor inside an unfinished literal or comment is not a completion position at all. Offering
  // table names in the middle of a string is the classic way a SQL completer becomes annoying.
  if (last && (last.kind === 'quoted' || last.kind === 'comment') && last.end === clamped) {
    return { target: 'none', prefix: '', references, replaceStart: clamped };
  }

  // The word being typed, when the cursor sits at the end of one.
  let prefix = '';
  let replaceStart = clamped;
  let index = tokens.length;
  if (last && last.kind === 'word' && last.end === clamped) {
    prefix = last.text;
    replaceStart = last.start;
    index = tokens.length - 1;
  }

  // A dotted qualifier, e.g. `u.` in `u.na`.
  let qualifier: string | undefined;
  const dotCandidate = tokens[index - 1];
  if (dotCandidate && dotCandidate.kind === 'punct' && dotCandidate.text === '.') {
    const nameToken = tokens[index - 2];
    if (nameToken && (nameToken.kind === 'word' || nameToken.kind === 'quoted')) {
      qualifier = unquote(nameToken.text);
      index -= 2;
    }
  }

  // With a qualifier, the answer is almost always a column of that table or alias.
  const target = qualifier !== undefined
    ? 'column'
    : scanForTarget(tokens, index);

  return { target, prefix, qualifier, references, replaceStart };
}

/**
 * Finds the nearest clause keyword at or before {@code fromIndex}.
 *
 * Stops at a statement separator so a keyword from an earlier statement cannot decide the context of
 * this one. Parenthesis depth is tracked while scanning so that an opening bracket after an
 * `INSERT INTO t` is recognised as a column list rather than a subquery - the same `(` means opposite
 * things after `INTO` and after `FROM`.
 */
function scanForTarget(tokens: readonly Token[], fromIndex: number): CompletionTarget {
  let depth = 0;

  for (let index = fromIndex - 1; index >= 0; index--) {
    const token = tokens[index];

    if (token.kind === 'punct') {
      if (token.text === ';') {
        return 'none';
      }
      if (token.text === ')') {
        depth++;
      } else if (token.text === '(') {
        depth--;
      }
      continue;
    }

    if (token.kind !== 'word') {
      continue;
    }

    const word = token.text.toLowerCase();
    if (TABLE_REFERENCE_KEYWORDS.has(word)) {
      // `INSERT INTO t (` starts a column list; `FROM (` starts a subquery. Only the former means a
      // column is expected here.
      if (word === 'into' && depth < 0) {
        return 'column';
      }
      return 'table';
    }
    if (TABLE_COMPLETION_KEYWORDS.has(word)) {
      return 'table';
    }
    if (COLUMN_KEYWORDS.has(word)) {
      return 'column';
    }
  }

  // Nothing recognisable: the start of a script, where a statement keyword is the useful suggestion.
  return 'none';
}

/**
 * Extracts the tables named in a fragment, with their aliases.
 *
 * Used to scope column completion. Without it, `SELECT * FROM a JOIN b WHERE x` would offer every
 * column of every table in the database, which is worse than offering none because the useful
 * entries are buried.
 *
 * @param baseOffset offset the fragment starts at, so token positions map back to the document
 */
export function referencedTables(fragment: string, baseOffset = 0): TableReference[] {
  const tokens = tokenize(fragment, 0, fragment.length);
  const references: TableReference[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'word' || !TABLE_REFERENCE_KEYWORDS.has(token.text.toLowerCase())) {
      continue;
    }

    // Read a possibly qualified name: `schema.table`, `catalog.schema.table`, or a bare name.
    let nameIndex = index + 1;
    const nameToken = tokens[nameIndex];
    if (!nameToken || (nameToken.kind !== 'word' && nameToken.kind !== 'quoted')) {
      continue;
    }

    let name = unquote(nameToken.text);
    let cursor = nameIndex + 1;
    // A subquery in parentheses has no name to contribute.
    while (
      tokens[cursor]?.kind === 'punct' &&
      tokens[cursor].text === '.' &&
      (tokens[cursor + 1]?.kind === 'word' || tokens[cursor + 1]?.kind === 'quoted')
    ) {
      name = `${name}.${unquote(tokens[cursor + 1].text)}`;
      cursor += 2;
    }

    let alias: string | undefined;
    const next = tokens[cursor];
    if (next?.kind === 'word' && next.text.toLowerCase() === 'as') {
      const aliasToken = tokens[cursor + 1];
      if (aliasToken && (aliasToken.kind === 'word' || aliasToken.kind === 'quoted')) {
        alias = unquote(aliasToken.text);
      }
    } else if (next && (next.kind === 'word' || next.kind === 'quoted')) {
      const candidate = unquote(next.text);
      // A bare word after a table name is an alias unless it starts a new clause.
      if (!NON_ALIAS_WORDS.has(candidate.toLowerCase())) {
        alias = candidate;
      }
    }

    references.push(alias ? { name, alias } : { name });
    index = cursor;
  }

  void baseOffset;
  return references;
}

// ---------------------------------------------------------------------------
// scanner
// ---------------------------------------------------------------------------

/**
 * Splits a fragment into tokens.
 *
 * Only needs to be correct about where words end and where literals and comments begin, since that is
 * all the analysis above depends on. Doubled-quote escapes are honoured so `'it''s'` is one token
 * rather than two, which would otherwise expose a stray word to the clause scan.
 */
export function tokenize(sql: string, from: number, to: number): Token[] {
  const tokens: Token[] = [];
  let index = from;

  while (index < to) {
    const char = sql[index];

    if (/\s/.test(char)) {
      index++;
      continue;
    }

    // Line comment.
    if (char === '-' && sql[index + 1] === '-') {
      const start = index;
      while (index < to && sql[index] !== '\n') {
        index++;
      }
      tokens.push({ kind: 'comment', text: sql.slice(start, index), start, end: index });
      continue;
    }

    // Block comment.
    if (char === '/' && sql[index + 1] === '*') {
      const start = index;
      index += 2;
      while (index < to && !(sql[index] === '*' && sql[index + 1] === '/')) {
        index++;
      }
      index = Math.min(to, index + 2);
      tokens.push({ kind: 'comment', text: sql.slice(start, index), start, end: index });
      continue;
    }

    // Quoted literal or identifier.
    if (char === "'" || char === '"' || char === '`') {
      const start = index;
      index++;
      while (index < to) {
        if (sql[index] === char) {
          if (sql[index + 1] === char) {
            index += 2;
            continue;
          }
          index++;
          break;
        }
        if (sql[index] === '\\') {
          index += 2;
          continue;
        }
        index++;
      }
      tokens.push({ kind: 'quoted', text: sql.slice(start, index), start, end: index });
      continue;
    }

    // Bracketed identifier, as used by SQL Server.
    if (char === '[') {
      const start = index;
      index++;
      while (index < to && sql[index] !== ']') {
        index++;
      }
      index = Math.min(to, index + 1);
      tokens.push({ kind: 'quoted', text: sql.slice(start, index), start, end: index });
      continue;
    }

    // Word: identifiers and keywords, including `$` and digits after the first character.
    if (/[A-Za-z_\u0080-\uFFFF]/.test(char)) {
      const start = index;
      while (index < to && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[index])) {
        index++;
      }
      tokens.push({ kind: 'word', text: sql.slice(start, index), start, end: index });
      continue;
    }

    if (/[0-9]/.test(char)) {
      const start = index;
      while (index < to && /[0-9.eE+-]/.test(sql[index])) {
        index++;
      }
      tokens.push({ kind: 'number', text: sql.slice(start, index), start, end: index });
      continue;
    }

    tokens.push({ kind: 'punct', text: char, start: index, end: index + 1 });
    index++;
  }

  return tokens;
}

/** Removes the quoting from a quoted identifier. */
function unquote(text: string): string {
  if (text.length < 2) {
    return text;
  }
  const first = text[0];
  const last = text[text.length - 1];
  const pairs: Record<string, string> = { '"': '"', '`': '`', "'": "'", '[': ']' };
  if (pairs[first] !== last) {
    return text;
  }
  const inner = text.slice(1, -1);
  return inner.split(last + last).join(last);
}

/**
 * Finds the start of the statement containing an offset.
 *
 * The analysis must not see tables from a previous statement in the same file, which would make
 * aliases and column suggestions bleed across statements.
 */
function findStatementStart(sql: string, offset: number): number {
  // Scan backwards for a semicolon that is not inside a literal or comment. Tokenising the whole
  // prefix would be wasteful on a large file, so this reuses the tokenizer over the prefix only.
  const tokens = tokenize(sql, 0, offset);
  let start = 0;
  for (const token of tokens) {
    if (token.kind === 'punct' && token.text === ';') {
      start = token.end;
    }
    // A comment or literal token that ends exactly at the offset means the cursor is inside it; the
    // statement start does not matter in that case, and treating the fragment as empty is safest.
    if ((token.kind === 'comment' || token.kind === 'quoted') && token.end === offset) {
      return offset;
    }
  }
  return start;
}
