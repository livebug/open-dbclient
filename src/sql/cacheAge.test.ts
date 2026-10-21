import assert from 'node:assert/strict';
import test from 'node:test';

import { isFresh } from './cacheAge.ts';

test('a zero lifetime never expires', () => {
  assert.equal(isFresh(0, 0, Number.MAX_SAFE_INTEGER), true);
});

test('a negative lifetime is treated as "never" rather than "always stale"', () => {
  assert.equal(isFresh(1_000, -5, 1_000_000), true);
});

test('a value inside its lifetime is fresh', () => {
  assert.equal(isFresh(1_000, 300_000, 1_000 + 299_999), true);
});

test('a value exactly one lifetime old is stale', () => {
  assert.equal(isFresh(1_000, 300_000, 1_000 + 300_000), false);
});

test('a value older than its lifetime is stale', () => {
  assert.equal(isFresh(1_000, 300_000, 1_000 + 300_001), false);
});
