/**
 * Tests for merging a bundled data file with a user copy.
 *
 * The behaviour that matters is that a missing, empty or malformed user file leaves the bundled
 * entries alone, and that one bad entry cannot take the others down with it.
 *
 * Run with: node --test src/util/configMerge.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeById, readEntries } from './configMerge.ts';

interface Entry {
  id: string;
  label: string;
  disabled?: boolean;
}

const bundled: Entry[] = [
  { id: 'mysql', label: 'MySQL' },
  { id: 'postgres', label: 'PostgreSQL' },
  { id: 'oracle', label: 'Oracle' },
];

test('no user file leaves the bundled entries untouched', () => {
  assert.deepEqual(mergeById(bundled, []), bundled);
});

test('a user entry with a new id is appended', () => {
  const merged = mergeById(bundled, [{ id: 'custom', label: 'Custom' }]);
  assert.deepEqual(
    merged.map((entry) => entry.id),
    ['mysql', 'postgres', 'oracle', 'custom'],
  );
});

test('a user entry with a matching id replaces it, in place', () => {
  // Position matters: the picker would otherwise reorder itself every time an entry was customised.
  const merged = mergeById(bundled, [{ id: 'postgres', label: 'Postgres (mine)' }]);
  assert.deepEqual(
    merged.map((entry) => entry.id),
    ['mysql', 'postgres', 'oracle'],
  );
  assert.equal(merged[1].label, 'Postgres (mine)');
});

test('disabled removes a bundled entry', () => {
  const merged = mergeById(bundled, [{ id: 'oracle', label: '', disabled: true }]);
  assert.deepEqual(
    merged.map((entry) => entry.id),
    ['mysql', 'postgres'],
  );
});

test('the disabled directive is not passed through to the result', () => {
  // It is an instruction to the merger; leaving it on the entry would make it look disabled later.
  const merged = mergeById(bundled, [{ id: 'postgres', label: 'Mine', disabled: false }]);
  assert.equal('disabled' in merged[1], false);
});

test('a user entry with no id is dropped', () => {
  // An entry that cannot be named cannot be overridden later, so it would be a trap.
  const merged = mergeById(bundled, [{ id: '', label: 'nameless' }]);
  assert.deepEqual(merged, bundled);
});

test('an empty bundled list with user entries works', () => {
  const merged = mergeById<Entry>([], [{ id: 'a', label: 'A' }]);
  assert.deepEqual(merged, [{ id: 'a', label: 'A' }]);
});

test('order of independent user entries is preserved', () => {
  const merged = mergeById(bundled, [
    { id: 'z', label: 'Z' },
    { id: 'a', label: 'A' },
  ]);
  assert.deepEqual(
    merged.map((entry) => entry.id),
    ['mysql', 'postgres', 'oracle', 'z', 'a'],
  );
});

test('reading entries from a parsed document tolerates every wrong shape', () => {
  assert.deepEqual(readEntries(null, 'templates'), []);
  assert.deepEqual(readEntries('nope', 'templates'), []);
  assert.deepEqual(readEntries({}, 'templates'), []);
  assert.deepEqual(readEntries({ templates: 'nope' }, 'templates'), []);
  assert.deepEqual(readEntries({ other: [] }, 'templates'), []);
});

test('reading entries keeps the valid ones and drops the rest', () => {
  const entries = readEntries(
    { templates: [{ id: 'good', label: 'Good' }, { label: 'no id' }, null, 'text', { id: 42 }] },
    'templates',
  );
  assert.deepEqual(entries, [{ id: 'good', label: 'Good' }]);
});
