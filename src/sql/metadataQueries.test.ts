import assert from 'node:assert/strict';
import { test } from 'node:test';

import { globToRegExp } from './actionTemplate.ts';
import {
  COLUMN_ROW_COLUMNS,
  INDEX_ROW_COLUMNS,
  NAME_ROW_COLUMNS,
} from './metadataRows.ts';
import {
  expandMetadataSql,
  matchMetadataQuery,
  metadataQueryExamples,
  METADATA_QUERY_KINDS,
  otherColumns,
  parseMetadataQueries,
  TABLE_REMARK_COLUMNS,
  TABLE_RESERVED_COLUMNS,
} from './metadataQueries.ts';

/**
 * Tests for the user-written metadata SQL.
 *
 * Two properties matter more than the rest. A rule that cannot be filled must not run at all - dropping
 * a filter changes which rows come back, not how quickly - and the examples that ship must be rules that
 * actually parse and actually match the URLs they claim, because they are what a user copies.
 */

const isMatch = (glob: string, url: string): boolean => globToRegExp(glob).test(url);

test('a usable rule is read', () => {
  const { queries, problems } = parseMetadataQueries([
    { id: 'pg', kind: 'tables', match: 'jdbc:postgresql:*', sql: 'SELECT 1' },
  ]);

  assert.deepEqual(problems, []);
  assert.deepEqual(queries, [
    { id: 'pg', kind: 'tables', match: 'jdbc:postgresql:*', sql: 'SELECT 1' },
  ]);
});

test('the setting may be absent or empty', () => {
  assert.deepEqual(parseMetadataQueries(undefined), { queries: [], problems: [] });
  assert.deepEqual(parseMetadataQueries(null), { queries: [], problems: [] });
  assert.deepEqual(parseMetadataQueries([]), { queries: [], problems: [] });
});

test('a setting that is not a list is reported', () => {
  const { queries, problems } = parseMetadataQueries('jdbc:postgresql:*');
  assert.equal(queries.length, 0);
  assert.equal(problems.length, 1);
});

test('an unrecognised kind is rejected rather than guessed', () => {
  // Defaulting to one of the reads would return rows of the wrong shape, and the tree would show
  // nonsense instead of reporting the typo.
  const { queries, problems } = parseMetadataQueries([
    { kind: 'colums', sql: 'SELECT 1' },
    { kind: '', sql: 'SELECT 1' },
    { sql: 'SELECT 1' },
  ]);

  assert.equal(queries.length, 0);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /'columns'/, 'the message lists what would have worked');
});

test('every read a rule can replace is accepted', () => {
  // One test rather than four: what matters is that the setting's own documentation and the parser agree,
  // and a kind that parses but is then never matched would be worse than one that is rejected.
  const { queries, problems } = parseMetadataQueries(
    METADATA_QUERY_KINDS.map((kind) => ({ kind, sql: 'SELECT 1' })),
  );

  assert.deepEqual(problems, []);
  assert.deepEqual(
    queries.map((rule) => rule.kind),
    [...METADATA_QUERY_KINDS],
  );
});

test('a rule with no SQL is dropped, and the others survive', () => {
  const { queries, problems } = parseMetadataQueries([
    { kind: 'tables', sql: '   ' },
    { kind: 'tables', sql: 'SELECT 1' },
  ]);

  assert.equal(problems.length, 1);
  assert.equal(queries.length, 1);
});

test('a missing id is generated and a duplicate is refused', () => {
  const { queries, problems } = parseMetadataQueries([
    { kind: 'tables', sql: 'SELECT 1' },
    { id: 'same', kind: 'tables', sql: 'SELECT 2' },
    { id: 'same', kind: 'schemas', sql: 'SELECT 3' },
  ]);

  assert.equal(queries[0].id, 'tables-1');
  assert.equal(problems.length, 1, 'the duplicate id is the only problem');
  assert.equal(queries.length, 2);
});

test('the first matching rule of the right kind wins', () => {
  const { queries } = parseMetadataQueries([
    { id: 'a', kind: 'tables', match: 'jdbc:postgresql:*', sql: 'SELECT 1' },
    { id: 'b', kind: 'tables', sql: 'SELECT 2' },
    { id: 'c', kind: 'schemas', sql: 'SELECT 3' },
  ]);

  assert.equal(matchMetadataQuery('tables', 'jdbc:postgresql://h/db', queries, isMatch)?.id, 'a');
  // A rule of the other kind is not a candidate, however well it matches.
  assert.equal(matchMetadataQuery('schemas', 'jdbc:mysql://h/db', queries, isMatch)?.id, 'c');
  // Postgres rules are skipped for MySQL, leaving the matchless fallback.
  assert.equal(matchMetadataQuery('tables', 'jdbc:mysql://h/db', queries, isMatch)?.id, 'b');
  assert.equal(matchMetadataQuery('tables', 'jdbc:postgresql://h/db', [], isMatch), undefined);
});

test('placeholders are filled with raw names', () => {
  const { sql, missing } = expandMetadataSql(
    "SELECT * FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name LIKE '${namePattern}' AND table_catalog = '${catalog}'",
    { schema: 'public', namePattern: 'ord%', catalog: 'db' },
  );

  assert.deepEqual(missing, []);
  // Unquoted, because these sit inside string literals: quoting them would look for a name that contains
  // the quoting character.
  assert.ok(sql.includes("table_schema = 'public'"));
  assert.ok(sql.includes("table_name LIKE 'ord%'"));
  assert.ok(sql.includes("table_catalog = 'db'"));
});

test('an absent pattern means everything rather than making the rule unusable', () => {
  // The tree asks for a plain listing without a pattern, which is the common case; treating that as
  // missing would disable every rule that filters by name.
  const { sql, missing } = expandMetadataSql('... LIKE \'${namePattern}\'', {});
  assert.deepEqual(missing, []);
  assert.equal(sql, "... LIKE '%'");
});

test('a missing catalog or schema stops the rule instead of dropping the filter', () => {
  const { missing } = expandMetadataSql("WHERE s = '${schema}' AND c = '${catalog}'", { schema: 'x' });
  assert.deepEqual(missing, ['catalog']);
});

test('an unknown placeholder is reported, not silently left in the SQL', () => {
  const { missing } = expandMetadataSql('WHERE t = \'${table}\'', { schema: 'x' });
  assert.deepEqual(missing, ['table']);
});

test('the literal placeholders bring their own quotes', () => {
  // A name is data. Putting it inside quotes by hand is a statement that breaks on the first table called
  // `it's`, and the safest place to fix that is where the value is known.
  const { sql, missing } = expandMetadataSql(
    'WHERE s = ${schemaLiteral} AND t = ${tableLiteral}',
    { schema: 'public', table: "it's" },
  );

  assert.equal(sql, "WHERE s = 'public' AND t = 'it''s'");
  assert.deepEqual(missing, []);
});

test('a literal placeholder is missing when the value is, like the raw one', () => {
  const { sql, missing } = expandMetadataSql('WHERE t = ${tableLiteral}', { schema: 'public' });

  // Left in place and reported: running the statement without the filter would return another table's
  // columns, which is a wrong answer rather than a slow one.
  assert.equal(sql, 'WHERE t = ${tableLiteral}');
  assert.deepEqual(missing, ['tableLiteral']);
});

test('the columns outside the contract are the other information, in result order', () => {
  assert.deepEqual(otherColumns(['TABLE_NAME', 'EST_ROWS', 'ENGINE']), ['EST_ROWS', 'ENGINE']);
  // Case-insensitively, because a driver may report an alias in either case.
  assert.deepEqual(otherColumns(['table_name', 'remarks', 'SIZE']), ['SIZE']);
  assert.deepEqual(otherColumns(['', '   ']), []);
  assert.deepEqual(otherColumns(TABLE_RESERVED_COLUMNS), []);
});

test('the comment may be spelled the way a catalog spells it', () => {
  assert.deepEqual(TABLE_REMARK_COLUMNS, ['REMARKS', 'TABLE_COMMENT', 'COMMENT']);
  for (const name of TABLE_REMARK_COLUMNS) {
    assert.ok(TABLE_RESERVED_COLUMNS.includes(name), `${name} must not become other information`);
  }
});

test('the shipped tables examples use the two things a rule may add', () => {
  // The examples are the only documentation most users will read, so they have to demonstrate the whole
  // point: a comment the tree shows as the table's Chinese name, and one extra field it shows in the
  // tooltip. Examples that returned names only would teach half the feature.
  const tables = metadataQueryExamples().filter((rule) => rule.kind === 'tables');
  assert.ok(tables.length > 0);

  for (const rule of tables) {
    const aliases = [...rule.sql.matchAll(/\sAS\s+([A-Z_][A-Z0-9_]*)/gi)].map((match) =>
      match[1].toUpperCase(),
    );
    assert.ok(aliases.includes('TABLE_NAME'), `${rule.id} must name the tables it returns`);
    assert.ok(
      TABLE_REMARK_COLUMNS.some((name) => aliases.includes(name)),
      `${rule.id} must return a comment, or the tree can only show physical names`,
    );
    assert.ok(
      aliases.some((alias) => !TABLE_RESERVED_COLUMNS.includes(alias)),
      `${rule.id} must return an extra field, so the extensibility is visible in the example`,
    );
  }
});

test('every alias a per-table example uses is one the reader looks for', () => {
  // The examples are the only documentation most people will read, and they were run against a real
  // PostgreSQL 16 and MariaDB 11 before being written down. What a server cannot tell us is whether the
  // extension reads the alias: a rule aliased `IS_PK` would run perfectly and produce a column with no key
  // icon, which is this test's job to catch.
  const known: Record<string, readonly string[]> = {
    schemas: NAME_ROW_COLUMNS.schemas,
    catalogs: NAME_ROW_COLUMNS.catalogs,
    tableTypes: NAME_ROW_COLUMNS.tableTypes,
    columns: Object.values(COLUMN_ROW_COLUMNS).flat(),
    indexes: Object.values(INDEX_ROW_COLUMNS).flat(),
  };

  for (const rule of metadataQueryExamples()) {
    // Table rules are excluded on purpose: an extra column there is kept and shown in the tooltip, so
    // `EST_ROWS` is not a mistake to be rejected.
    const accepted = known[rule.kind];
    if (!accepted) {
      continue;
    }
    for (const match of rule.sql.matchAll(/\sAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
      assert.ok(
        accepted.includes(match[1].toUpperCase()),
        `${rule.id} returns '${match[1]}', which a ${rule.kind} rule does not read`,
      );
    }
  }
});

test('the shipped examples are rules that parse, match and use known placeholders', () => {
  const examples = metadataQueryExamples();
  const { queries, problems } = parseMetadataQueries(examples);

  assert.deepEqual(problems, [], 'every example must parse');
  assert.equal(queries.length, examples.length, 'no example may be dropped');

  // Every placeholder a rule may use is offered here, so an example that reaches for one the runner cannot
  // fill fails this rather than failing on somebody's database.
  const values = { catalog: 'db', schema: 'public', table: 'orders', namePattern: 'ord%' };
  for (const rule of queries) {
    assert.ok(rule.match, `${rule.id} must claim a URL, or it would apply everywhere`);
    assert.ok(isMatch(rule.match, rule.match.replace('*', 'host:5432/db')), rule.id);

    const { missing } = expandMetadataSql(rule.sql, values);
    assert.deepEqual(missing, [], `${rule.id} uses a placeholder nothing can fill`);
  }

  const ids = queries.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');

  // The per-table reads are the ones worth having an example for: they are what makes expanding a table
  // slow, and they are the ones where a name has to reach the statement safely.
  for (const kind of ['tables', 'columns'] as const) {
    assert.ok(
      queries.some((rule) => rule.kind === kind),
      `the examples must cover '${kind}', which is where the time goes`,
    );
  }
  for (const rule of queries.filter((rule) => rule.kind === 'columns' || rule.kind === 'indexes')) {
    assert.match(
      rule.sql,
      /\$\{(schema|table)Literal\}/,
      `${rule.id} must use a literal placeholder rather than putting quotes around a name by hand`,
    );
  }
});
