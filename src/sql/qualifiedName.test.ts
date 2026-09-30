import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expandMetadataSql } from './metadataQueries.ts';
import { parseQualifiedName, schemaForTable, scopeOfTable } from './qualifiedName.ts';

/**
 * Tests for how a table name is turned into the parts a metadata read takes.
 *
 * Both halves of this were measured against a real driver before they were written:
 *
 * - SQLite answered 0 rows for the columns of `main.user_account`, and the table's two columns for the
 *   split form `schema='main'` + `table='user_account'`. Handing a driver a qualified name as though it
 *   were a table name is how a statement written `FROM main.user_account` offered no columns at all.
 * - A rule that filters on `${schemaLiteral}` is refused when the read names no schema, and refusing means
 *   the driver answers instead - the slow read the rule exists to avoid.
 */

const PUBLIC = { name: 'public', kind: 'schema' as const, tables: ['orders', 'users'] };
const SALES = { name: 'sales', kind: 'schema' as const, tables: ['orders'] };
const CATALOG = { name: 'shop', kind: 'catalog' as const, tables: ['orders'] };

test('a bare name is just the table', () => {
  assert.deepEqual(parseQualifiedName('users'), {
    catalog: undefined,
    schema: undefined,
    table: 'users',
  });
});

test('a qualified name is split into the parts a metadata call takes', () => {
  assert.deepEqual(parseQualifiedName('public.users'), {
    catalog: undefined,
    schema: 'public',
    table: 'users',
  });
  assert.deepEqual(parseQualifiedName('shop.public.users'), {
    catalog: 'shop',
    schema: 'public',
    table: 'users',
  });
});

test('an unusable name still yields the parts it has', () => {
  // Half-written names are the normal case while somebody types, and none of these may throw.
  assert.deepEqual(parseQualifiedName('.users'), {
    catalog: undefined,
    schema: undefined,
    table: 'users',
  });
  assert.deepEqual(parseQualifiedName('users.'), {
    catalog: undefined,
    schema: undefined,
    table: 'users',
  });
  assert.deepEqual(parseQualifiedName(''), { catalog: undefined, schema: undefined, table: '' });
});

test('a bare name is attributed to the one schema that holds it', () => {
  assert.equal(schemaForTable([PUBLIC, SALES, CATALOG], undefined, 'users'), 'public');
});

test('a name two schemas hold stays schema-less', () => {
  // The driver then searches both, which is what it would have done without the listing, and a rule that
  // needs one schema is refused rather than run against an arbitrary guess.
  assert.equal(schemaForTable([PUBLIC, SALES], 'public', 'orders'), undefined);
});

test('a catalog is not mistaken for a schema', () => {
  assert.equal(schemaForTable([CATALOG], undefined, 'orders'), undefined);
});

test('an unknown name falls back to the connection own schema', () => {
  // A table created since the listing was read: with exactly one schema there is no ambiguity left.
  assert.equal(schemaForTable([PUBLIC], 'public', 'just_created'), 'public');
  assert.equal(schemaForTable([PUBLIC, SALES], undefined, 'just_created'), undefined);
});

test('a name that carries its schema is left alone', () => {
  const scoped = scopeOfTable({ table: 'orders', schema: 'sales' }, [PUBLIC, SALES], 'public');
  assert.equal(scoped.schema, 'sales', 'the statement wins over the listing');

  assert.deepEqual(scopeOfTable({ table: 'users' }, [PUBLIC, SALES], undefined), {
    table: 'users',
    schema: 'public',
  });
});

test('nothing is added when there is no listing yet', () => {
  // The prefetch is asynchronous, so a completion can arrive before it finishes. Asking the driver without a
  // schema is the old behaviour and still correct - it is only slower.
  assert.deepEqual(scopeOfTable({ table: 'users' }, [], undefined), {
    table: 'users',
    schema: undefined,
  });
});

test('the schema the listing supplies is what makes a ${schemaLiteral} rule runnable', () => {
  // The user-visible form of this: a rule that filters on `${schemaLiteral}` was reported as
  // "not available for this read" while typing `SELECT * FROM orders`, the rule was refused, and the driver
  // answered instead - the slow read the rule was written to replace.
  const rule = 'WHERE n.nspname = ${schemaLiteral} AND c.relname = ${tableLiteral}';

  const scoped = scopeOfTable({ table: 'orders' }, [PUBLIC], undefined);
  assert.deepEqual(
    expandMetadataSql(rule, { catalog: undefined, schema: scoped.schema, table: scoped.table }).missing,
    [],
    'a schema taken from the listing fills the placeholder',
  );

  assert.deepEqual(
    expandMetadataSql(rule, { catalog: undefined, schema: undefined, table: 'orders' }).missing,
    ['schemaLiteral'],
    'and with no schema, the rule is refused - which is the warning that was reported',
  );
});
