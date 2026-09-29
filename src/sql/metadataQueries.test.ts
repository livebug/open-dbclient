import assert from 'node:assert/strict';
import { test } from 'node:test';

import { globToRegExp } from './actionTemplate.ts';
import {
  expandMetadataSql,
  matchMetadataQuery,
  metadataQueryExamples,
  parseMetadataQueries,
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
  // Defaulting to one of the two reads would return rows of the wrong shape, and the tree would show
  // nonsense instead of reporting the typo.
  const { queries, problems } = parseMetadataQueries([
    { kind: 'columns', sql: 'SELECT 1' },
    { kind: '', sql: 'SELECT 1' },
    { sql: 'SELECT 1' },
  ]);

  assert.equal(queries.length, 0);
  assert.equal(problems.length, 3);
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

test('the shipped examples are rules that parse, match and use known placeholders', () => {
  const examples = metadataQueryExamples();
  const { queries, problems } = parseMetadataQueries(examples);

  assert.deepEqual(problems, [], 'every example must parse');
  assert.equal(queries.length, examples.length, 'no example may be dropped');

  for (const rule of queries) {
    assert.ok(rule.match, `${rule.id} must claim a URL, or it would apply everywhere`);
    assert.ok(isMatch(rule.match, rule.match.replace('*', 'host:5432/db')), rule.id);

    // Whatever else they contain, the placeholders have to be ones the runner can fill.
    const { missing } = expandMetadataSql(rule.sql, { schema: 'public' });
    assert.deepEqual(missing, [], `${rule.id} uses a placeholder nothing can fill`);
  }

  const ids = queries.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  assert.ok(
    queries.some((rule) => rule.kind === 'tables'),
    'the slow read this exists for must be covered',
  );
});
