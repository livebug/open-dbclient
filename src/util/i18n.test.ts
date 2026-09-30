import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ZH_CN } from './messages.zh-cn.ts';
import { currentLocale, resolveLocale, setLocale, t } from './i18n.ts';

/**
 * Tests for the message catalog.
 *
 * The catalog is data, and data is where a typo is silent: a key that does not match the call site
 * produces English in a Chinese UI, which nobody notices until a user does. These tests pin the
 * mechanics (locale mapping, fallback, substitution) and the one property of the data that can be
 * checked without a list of call sites: that no entry is present but empty.
 */

test('a language tag maps onto a catalog', () => {
  assert.equal(resolveLocale('en'), 'en');
  assert.equal(resolveLocale('en-US'), 'en');
  assert.equal(resolveLocale('zh-cn'), 'zh-cn');
  assert.equal(resolveLocale('zh-CN'), 'zh-cn');
  // Traditional Chinese is served the neighbouring script rather than nothing at all.
  assert.equal(resolveLocale('zh-TW'), 'zh-cn');
  assert.equal(resolveLocale('zh'), 'zh-cn');
  // A tag with an underscore, as some environments report it.
  assert.equal(resolveLocale('zh_CN'), 'zh-cn');
  assert.equal(resolveLocale(undefined), 'en');
  assert.equal(resolveLocale(''), 'en');
});

test('English is the default and needs no catalog', () => {
  setLocale('en');
  assert.equal(currentLocale(), 'en');
  assert.equal(t('Completed'), 'Completed');
});

test('arguments are substituted in order', () => {
  setLocale('en');
  assert.equal(t('{0} row(s)', 12), '12 row(s)');
  assert.equal(t('Rows {0}–{1} of {2}', '1', '2', '3'), 'Rows 1–2 of 3');
});

test('an unknown message falls back to the English text, arguments included', () => {
  setLocale('zh-cn');
  // A half-translated UI is readable; an empty string or a raw key is not.
  assert.equal(t('This message has no translation {0}', 7), 'This message has no translation 7');
});

test('a translated message keeps its arguments', () => {
  setLocale('zh-cn');
  assert.equal(t('{0} row(s)', 12), '12 行');
  assert.equal(t('Result - {0}', 'demo'), '结果 - demo');
});

test('translation never runs on data, so a value that looks like a key is left alone', () => {
  setLocale('zh-cn');
  // The call sites pass data as an argument rather than through `t`; this is the guarantee that makes
  // that matter: a column named "Completed" must stay "Completed".
  assert.equal(t('{0}', 'Completed'), 'Completed');
});

test('every catalog entry is a non-empty string', () => {
  for (const [key, value] of Object.entries(ZH_CN)) {
    assert.ok(key.trim() !== '', 'a catalog key must not be blank');
    assert.ok(
      typeof value === 'string' && value.trim() !== '',
      `the translation for ${JSON.stringify(key)} is empty, which would render as nothing at all`,
    );
  }
});

test('the placeholder numbers a translation uses exist in its English text', () => {
  for (const [key, value] of Object.entries(ZH_CN)) {
    const expected = new Set([...key.matchAll(/\{(\d+)\}/g)].map((match) => match[1]));
    const used = [...value.matchAll(/\{(\d+)\}/g)].map((match) => match[1]);
    for (const index of used) {
      assert.ok(
        expected.has(index),
        `the translation for ${JSON.stringify(key)} uses {${index}}, which the English text does not ` +
          'provide; the argument would never be substituted',
      );
    }
  }
});

test('log lines go through the same catalog as the UI', () => {
  setLocale('zh-cn');
  // The output channel is where "why is this slow?" is answered, so a Chinese UI with an English log is a
  // gap a user notices. These are the lines they read while working out which read to replace with SQL.
  assert.equal(
    t("Reading the columns of {0} on {1} from the driver's metadata", 'public.orders', 'Production'),
    '从驱动元数据读取连接 Production 上 public.orders 的列',
  );
  assert.equal(
    t(
      "Running metadata query '{0}' for {1} on '{2}': {3}",
      'fast-columns',
      t('columns'),
      'Production',
      'SELECT 1',
    ),
    '用元数据查询「fast-columns」读取 列(连接「Production」):SELECT 1',
  );
  assert.equal(
    t("Finished in {0} ms on '{1}': {2}", 42, 'Production', t('{0} row(s)', '1,204')),
    '在「Production」上完成,用时 42 ms:1,204 行',
  );
});

test('a subject is assembled from parts so each language can order them', () => {
  setLocale('zh-cn');
  // `columns of public.orders` reads as `public.orders 的列`: the order comes from the catalog rather than
  // from the call site, which is why a rule log line is passed a kind and a scope instead of a phrase.
  assert.equal(t('{0} of {1}', t('columns'), 'public.orders'), 'public.orders 的列');

  setLocale('en');
  assert.equal(t('{0} of {1}', t('columns'), 'public.orders'), 'columns of public.orders');
});
