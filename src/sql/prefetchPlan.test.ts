import assert from 'node:assert/strict';
import test from 'node:test';

import { prefetchScopes } from './prefetchPlan.ts';

test('several schemas are read one at a time', () => {
  assert.deepEqual(prefetchScopes(['public', 'sales', 'staging'], [], false), [
    { schema: 'public' },
    { schema: 'sales' },
    { schema: 'staging' },
  ]);
});

test('a single schema stays one read, with no redundant narrowing', () => {
  assert.deepEqual(prefetchScopes(['public'], [], false), [{}]);
});

test('without a schema level the read is split by catalog instead', () => {
  assert.deepEqual(prefetchScopes([], ['app', 'reporting'], false), [
    { catalog: 'app' },
    { catalog: 'reporting' },
  ]);
});

test('a fixed catalog is never split: that driver cannot read across catalogs', () => {
  assert.deepEqual(prefetchScopes([], ['app', 'reporting'], true), [{}]);
});

test('nothing to split by means one whole-database read', () => {
  assert.deepEqual(prefetchScopes([], [], false), [{}]);
});

test('the schema split wins when both levels exist', () => {
  assert.deepEqual(prefetchScopes(['public', 'sales'], ['app', 'reporting'], false), [
    { schema: 'public' },
    { schema: 'sales' },
  ]);
});
