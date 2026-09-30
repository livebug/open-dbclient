import assert from 'node:assert/strict';
import { test } from 'node:test';

import { catalogLevel } from './catalogLevel.ts';

/**
 * Tests for the catalog level decision.
 *
 * This is where a real wrong answer was found: PostgreSQL reports every database in the cluster as a
 * catalog and then ignores the catalog argument, so a level built from the count alone showed the
 * connected database's tables under the name of two other databases. The measurements are in the module's
 * comment; what is checked here is that the count is never the only input.
 */

test('catalogs are listed when the driver can read inside them', () => {
  const level = catalogLevel(['information_schema', 'mysql', 'shop'], true);

  assert.equal(level.show, true, 'several usable catalogs are worth a level');
  assert.equal(level.catalog, undefined, 'and each node carries its own name');
});

test('several catalogs are ignored when the driver cannot read inside them', () => {
  // The PostgreSQL case: otherdb, postgres, template1 come back, and `getTables("otherdb", ...)` returns
  // the tables of the connection's own database.
  const level = catalogLevel(['otherdb', 'postgres', 'template1'], false);

  assert.equal(level.show, false, 'a level whose nodes all open onto the same tables is a lie');
  assert.equal(
    level.catalog,
    undefined,
    'nothing is passed down either, so the driver keeps using the database the user connected to',
  );
});

test('a single catalog is carried down instead of becoming a node', () => {
  const level = catalogLevel(['shop'], true);

  assert.equal(level.show, false, 'a level with one node in it is a click for nothing');
  assert.equal(level.catalog, 'shop', 'but the name is still used, so the read is scoped as usual');
});

test('no catalogs at all leaves the read to the connection', () => {
  for (const supports of [true, false]) {
    const level = catalogLevel([], supports);

    assert.equal(level.show, false, String(supports));
    assert.equal(level.catalog, undefined, String(supports));
  }
});

test('two unusable catalogs are as useless as three', () => {
  assert.equal(catalogLevel(['a', 'b'], false).show, false);
  assert.equal(catalogLevel(['a', 'b'], true).show, true, 'and the same two are enough when usable');
});
