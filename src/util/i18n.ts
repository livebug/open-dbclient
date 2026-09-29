/**
 * Message localisation for everything the extension shows a user.
 *
 * Choices worth explaining, because a smaller mechanism was possible:
 *
 * - **The English text is the key.** There are no invented identifiers like `run.noEditor`. An
 *   identifier table needs a lookup to read the code, and a translation that is merely missing is
 *   invisible; with the text as the key a gap falls back to a sentence the user can still act on, and
 *   the code stays readable at the call site.
 * - **Not `vscode.l10n`.** The catalog has to be usable from three places that cannot see each other:
 *   the extension host, the webview bundles (which are separate esbuild outputs with no `vscode`
 *   module at all), and plain Node unit tests. A module with no `vscode` import is the only shape that
 *   serves all three.
 * - **`{0}`-style placeholders.** `${...}` would collide with the SQL the messages are often about.
 *
 * The locale is pushed in rather than sniffed, so the same catalog works in a webview after the host
 * tells it which language the UI is in.
 */

/** Locales this project ships a catalog for. */
export type SupportedLocale = 'en' | 'zh-cn';

// The explicit `.ts` extension is required: `node --test` runs the unit tests through Node's type
// stripping with ESM resolution, which does not guess extensions. Modules that unit tests import
// directly reach this file, so the extension has to be written out even though bundlers accept both.
import { ZH_CN } from './messages.zh-cn.ts';

const CATALOGS: Record<SupportedLocale, Record<string, string>> = {
  en: {},
  'zh-cn': ZH_CN,
};

let locale: SupportedLocale = 'en';

/**
 * Maps a VS Code language tag onto a catalog.
 *
 * `zh-tw` and `zh-hk` get the Simplified catalog rather than English: a reader of Traditional Chinese
 * is far better served by the neighbouring script than by no translation at all.
 */
export function resolveLocale(language: string | undefined): SupportedLocale {
  if (!language) {
    return 'en';
  }
  const normalised = language.toLowerCase().replace(/_/g, '-');
  return normalised === 'zh' || normalised.startsWith('zh-') ? 'zh-cn' : 'en';
}

/** Sets the catalog used by `t`. Passing no language resets to English. */
export function setLocale(language: string | undefined): void {
  locale = resolveLocale(language);
}

export function currentLocale(): SupportedLocale {
  return locale;
}

/**
 * Translates a message, substituting `{0}`, `{1}`… with the arguments.
 *
 * A message with no translation is returned as written, arguments included. That is deliberate: a
 * half-translated UI is readable, whereas an empty string or a key like `run.no-editor` is not.
 */
export function t(message: string, ...args: readonly (string | number)[]): string {
  const catalog = CATALOGS[locale];
  const template = catalog[message] ?? message;
  if (args.length === 0) {
    return template;
  }
  return template.replace(/\{(\d+)\}/g, (whole, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Translates a message that is a fragment of a larger sentence.
 *
 * Exists so that call sites joining several pieces can do so in a translated order: the Chinese text
 * for a list separator or a prefix is not always the English one, and translating each piece and
 * concatenating is the only way to keep both languages idiomatic.
 */
export const join = (...parts: readonly string[]): string => parts.filter(Boolean).join('');
