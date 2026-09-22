/**
 * Tests for the `key=value;key=value` text used for JDBC driver properties.
 *
 * Run with: node --test src/model/connectionProperties.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatProperties,
  parseProperties,
  validateJdbcUrl,
  validateProperties,
} from './connectionProperties.ts';

test('parses pairs separated by semicolons', () => {
  assert.deepEqual(parseProperties('a=1;b=2'), { a: '1', b: '2' });
});

test('only the first equals sign splits a pair', () => {
  // This is the case that matters: passwords and tokens routinely contain '=', and splitting on the
  // last one would produce a property whose value is the left half.
  assert.deepEqual(parseProperties('password=a=b=c'), { password: 'a=b=c' });
});

test('whitespace around keys and values is trimmed', () => {
  assert.deepEqual(parseProperties('  a  =  1  ;  b = 2 '), { a: '1', b: '2' });
});

test('empty segments and a trailing semicolon are ignored', () => {
  assert.deepEqual(parseProperties('a=1;;;'), { a: '1' });
  assert.deepEqual(parseProperties('   '), {});
  assert.deepEqual(parseProperties(''), {});
});

test('an entry with no equals sign is dropped rather than guessed at', () => {
  assert.deepEqual(parseProperties('a=1;oops;b=2'), { a: '1', b: '2' });
});

test('a leading equals sign is not treated as a key', () => {
  // `=value` has an empty key, which would be a property named "".
  assert.deepEqual(parseProperties('=value;a=1'), { a: '1' });
});

test('an empty value is kept, because the driver distinguishes it from absence', () => {
  assert.deepEqual(parseProperties('a='), { a: '' });
});

test('formatting and parsing round trip', () => {
  const properties = { a: '1', b: 'has spaces', c: 'has=equals' };
  assert.deepEqual(parseProperties(formatProperties(properties)), properties);
});

test('formatting nothing gives empty text', () => {
  assert.equal(formatProperties(undefined), '');
  assert.equal(formatProperties({}), '');
});

test('validation accepts well formed text', () => {
  assert.equal(validateProperties(''), undefined);
  assert.equal(validateProperties('a=1;b=2'), undefined);
  assert.equal(validateProperties('a='), undefined);
});

test('validation rejects an entry without an equals sign and names it', () => {
  const problem = validateProperties('a=1;oops');
  assert.match(problem ?? '', /oops/);
});

test('a JDBC URL must be present and start with jdbc:', () => {
  assert.match(validateJdbcUrl('') ?? '', /required/);
  assert.match(validateJdbcUrl('   ') ?? '', /required/);
  assert.match(validateJdbcUrl('postgresql://host/db') ?? '', /jdbc:/);
  assert.equal(validateJdbcUrl('jdbc:postgresql://host:5432/db'), undefined);
  // Case is not meaningful here, and a user typing JDBC: means the same thing.
  assert.equal(validateJdbcUrl('JDBC:h2:mem:test'), undefined);
});
