/**
 * Splits a SQL script into individual statements.
 *
 * The bridge executes exactly one statement per request, so this is what makes running a script
 * work. Getting it wrong is worse than it looks: splitting on every semicolon would break any
 * statement containing one inside a string literal, and the user would see a syntax error pointing
 * at a line they wrote correctly.
 *
 * A scanner is used rather than a parser or a regular expression. A regular expression cannot
 * track state, and a full parser would reject the half-written SQL that is the normal state of a
 * file being edited - the very case where running a statement matters most.
 *
 * Handled: single-quoted strings with doubled-quote escapes, double-quoted and backtick-quoted
 * identifiers, line comments, block comments, and PostgreSQL dollar-quoted strings.
 * Not handled: vendor procedural blocks (a `BEGIN ... END` body containing semicolons), which would
 * need dialect knowledge the project deliberately avoids.
 */
export interface SqlStatement {
  /** Statement text with surrounding whitespace trimmed. */
  readonly text: string;
  /** Offset of the statement's first non-whitespace character in the source. */
  readonly start: number;
  /** Offset just past the statement's last non-whitespace character. */
  readonly end: number;
}

/** Splits a script, discarding empty statements produced by trailing or repeated separators. */
export function splitStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let statementStart = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    // Comments and literals are skipped wholesale; a semicolon inside one is just text.
    if (char === '-' && sql[index + 1] === '-') {
      index = skipLineComment(sql, index + 2);
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      index = skipBlockComment(sql, index + 2);
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      index = skipQuoted(sql, index, char);
      continue;
    }
    if (char === '$') {
      const dollarQuoteEnd = skipDollarQuoted(sql, index);
      if (dollarQuoteEnd > index) {
        index = dollarQuoteEnd;
        continue;
      }
    }

    if (char === ';') {
      pushStatement(statements, sql, statementStart, index);
      statementStart = index + 1;
    }
    index++;
  }

  pushStatement(statements, sql, statementStart, sql.length);
  return statements;
}

/**
 * Finds the statement containing a cursor offset.
 *
 * Used to run "the statement under the cursor", which is what Ctrl+Enter should do when nothing is
 * selected: a user editing one statement among many expects the editor to know which one they mean.
 * When the offset falls in the whitespace between statements, the following one is chosen, matching
 * the intuition that the cursor sits before the statement it is about to run.
 */
export function statementAt(sql: string, offset: number): SqlStatement | undefined {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    return undefined;
  }

  const clamped = Math.max(0, Math.min(offset, sql.length));
  for (const statement of statements) {
    if (clamped >= statement.start && clamped <= statement.end) {
      return statement;
    }
  }

  // Between statements: take the next one, or the last if the cursor is past everything.
  return statements.find((statement) => statement.start > clamped) ?? statements[statements.length - 1];
}

/**
 * Returns the text a run command should execute.
 *
 * A non-empty selection always wins, because selecting part of a statement is the standard way to
 * run a fragment, and a user who has highlighted something means it.
 */
export function resolveStatementToRun(
  sql: string,
  selection: { readonly isEmpty: boolean; readonly start: number; readonly end: number },
  cursorOffset: number,
): string | undefined {
  if (!selection.isEmpty) {
    const selected = sql.slice(selection.start, selection.end).trim();
    return selected.length > 0 ? selected : undefined;
  }

  const statement = statementAt(sql, cursorOffset);
  if (!statement) {
    return undefined;
  }
  // A selection-less run of a script-wide statement list should still send one statement at a time,
  // so the statement text never contains a separator.
  return statement.text;
}

/**
 * Returns true when a statement looks destructive enough to warrant confirmation.
 *
 * Deliberately narrow. Warning about every `DELETE` would train users to dismiss the prompt, which
 * is how a safety net stops working; an unbounded `DELETE` or `UPDATE` is the case worth pausing on,
 * as is a `DROP` or `TRUNCATE`.
 */
export function isDestructive(statement: string): boolean {
  const normalized = stripComments(statement).trim().toUpperCase();
  if (/^(DROP|TRUNCATE)\b/.test(normalized)) {
    return true;
  }
  if (/^(DELETE|UPDATE)\b/.test(normalized)) {
    // With no WHERE clause at all, the statement affects the whole table.
    return !/\bWHERE\b/.test(normalized);
  }
  return false;
}

// ---------------------------------------------------------------------------
// scanner internals
// ---------------------------------------------------------------------------

function pushStatement(target: SqlStatement[], sql: string, rawStart: number, rawEnd: number): void {
  let start = rawStart;
  let end = rawEnd;

  // Trim whitespace, including comments-only fragments, without moving the offsets outside the text.
  while (start < end && /\s/.test(sql[start])) {
    start++;
  }
  while (end > start && /\s/.test(sql[end - 1])) {
    end--;
  }
  if (start >= end) {
    return;
  }

  const text = sql.slice(start, end);
  // A fragment holding only comments has nothing to execute.
  if (stripComments(text).trim().length === 0) {
    return;
  }
  target.push({ text, start, end });
}

/** Advances past a `--` comment, stopping before the newline that ends it. */
function skipLineComment(sql: string, from: number): number {
  let index = from;
  while (index < sql.length && sql[index] !== '\n') {
    index++;
  }
  return index;
}

/**
 * Advances past a block comment.
 *
 * Block comments nest in PostgreSQL and several other databases, so a depth counter is kept rather
 * than stopping at the first terminator - otherwise `/* outer /* inner *​/ still outer *​/` would end
 * early and expose the rest of the comment to the splitter.
 */
function skipBlockComment(sql: string, from: number): number {
  let depth = 1;
  let index = from;
  while (index < sql.length && depth > 0) {
    if (sql[index] === '/' && sql[index + 1] === '*') {
      depth++;
      index += 2;
    } else if (sql[index] === '*' && sql[index + 1] === '/') {
      depth--;
      index += 2;
    } else {
      index++;
    }
  }
  return index;
}

/**
 * Advances past a quoted region.
 *
 * The doubled-quote escape (`''` inside a single-quoted string, `""` inside a quoted identifier) is
 * the standard way to embed the delimiter, and must not be mistaken for the end of the value.
 */
function skipQuoted(sql: string, from: number, quote: string): number {
  let index = from + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    // A backslash escape is honoured inside backticks and single quotes, which MySQL and others
    // accept. Treating it as literal text would let an escaped quote end the string early.
    if (sql[index] === '\\' && quote !== '"') {
      index += 2;
      continue;
    }
    index++;
  }
  return index;
}

/**
 * Advances past a PostgreSQL dollar-quoted string, or returns {@code from} when there is none.
 *
 * The delimiter is a tag such as `$$` or `$body$`, and it must be matched by the identical tag, so
 * the opening tag is captured and searched for rather than assumed to be `$$`.
 */
function skipDollarQuoted(sql: string, from: number): number {
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(from));
  if (!match) {
    return from;
  }
  const tag = match[0];
  const closing = sql.indexOf(tag, from + tag.length);
  return closing < 0 ? sql.length : closing + tag.length;
}

/**
 * Removes comments so keyword checks are not fooled by text inside them.
 *
 * Used only for the destructive-statement heuristic: a leading `/* maintenance *​/ DROP TABLE x`
 * is still a drop.
 */
function stripComments(sql: string): string {
  let result = '';
  let index = 0;
  while (index < sql.length) {
    if (sql[index] === '-' && sql[index + 1] === '-') {
      index = skipLineComment(sql, index + 2);
      result += ' ';
      continue;
    }
    if (sql[index] === '/' && sql[index + 1] === '*') {
      index = skipBlockComment(sql, index + 2);
      result += ' ';
      continue;
    }
    result += sql[index];
    index++;
  }
  return result;
}
