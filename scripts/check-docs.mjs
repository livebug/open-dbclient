/**
 * Checks that the documentation still agrees with the manifest.
 *
 * Every claim below is something that had already gone wrong once: the README listed a connection
 * template that does not exist, named a settings key that is not contributed, told users to type a
 * command palette prefix that does not match the command category, and had a table-of-contents entry
 * pointing at a heading that had been renamed. None of those break the build, and all of them are
 * invisible until a user hits them.
 *
 * Runs as part of `npm test`. Exits non-zero and prints every problem it found.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));

const problems = [];
const check = (message) => console.log(`  ok  ${message}`);
const fail = (message) => {
  problems.push(message);
  console.log(`  FAIL ${message}`);
};

// --- relative links -------------------------------------------------------------------------------

const relativeLinks = [...readme.matchAll(/\]\((?!https?:|#)([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
const brokenLinks = [...new Set(relativeLinks)].filter((target) => !existsSync(join(root, target)));
if (brokenLinks.length > 0) {
  fail(`README links to missing files: ${brokenLinks.join(', ')}`);
} else {
  check(`${new Set(relativeLinks).size} relative links resolve`);
}

// --- table of contents anchors --------------------------------------------------------------------

// GitHub's slug algorithm, near enough for the headings used here.
const slugify = (heading) =>
  heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

const slugs = new Set([...readme.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slugify(m[1])));
const anchors = [...new Set([...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]))];
const brokenAnchors = anchors.filter((a) => !slugs.has(a));
if (brokenAnchors.length > 0) {
  fail(`README anchors point at no heading: ${brokenAnchors.join(', ')}`);
} else {
  check(`${anchors.length} anchors resolve`);
}

// --- settings -------------------------------------------------------------------------------------

const configuration = pkg.contributes.configuration;
const properties = Object.assign(
  {},
  ...(Array.isArray(configuration) ? configuration : [configuration]).map((c) => c.properties ?? {}),
);

// Settings are documented in tables whose first cell is the key without the `open-dbclient.` prefix.
const documentedSettings = [...new Set([...readme.matchAll(/^\| `([^`]+)`\s+\|/gm)].map((m) => m[1]))];
const unknownSettings = documentedSettings.filter((key) => !(`open-dbclient.${key}` in properties));
if (unknownSettings.length > 0) {
  fail(`README documents settings that are not contributed: ${unknownSettings.join(', ')}`);
} else {
  check(`${documentedSettings.length} documented settings exist`);
}

// --- command palette labels -----------------------------------------------------------------------

const paletteLabels = new Set(
  pkg.contributes.commands.map((c) => (c.category ? `${c.category}: ${c.title}` : c.title)),
);
const referencedCommands = [
  ...new Set([...readme.matchAll(/\*\*([^*:]+: [^*]+)\*\*/g)].map((m) => m[1].trim())),
].filter((label) => label.startsWith('DB Client:'));
const unknownCommands = referencedCommands.filter((label) => !paletteLabels.has(label));
if (unknownCommands.length > 0) {
  fail(`README shows command palette labels that do not exist: ${unknownCommands.join(' | ')}`);
} else {
  check(`${referencedCommands.length} command palette labels exist`);
}

// --- keybindings and views ------------------------------------------------------------------------

const undocumentedKeybindings = pkg.contributes.keybindings
  .map((k) => pkg.contributes.commands.find((c) => c.command === k.command)?.title)
  .filter((title) => title !== undefined && !readme.includes(title));
if (undocumentedKeybindings.length > 0) {
  fail(`keybound commands are not documented: ${undocumentedKeybindings.join(', ')}`);
} else {
  check(`${pkg.contributes.keybindings.length} keybindings are documented`);
}

const undocumentedViews = pkg.contributes.views['open-dbclient']
  .map((v) => v.name)
  .filter((name) => !readme.includes(name));
if (undocumentedViews.length > 0) {
  fail(`views are not mentioned in the README: ${undocumentedViews.join(', ')}`);
} else {
  check(`${pkg.contributes.views['open-dbclient'].length} views are mentioned`);
}

// --- changelog ------------------------------------------------------------------------------------

// Only checked when a CHANGELOG exists, since it is what the release workflow publishes as notes.
if (existsSync(join(root, 'CHANGELOG.md'))) {
  const changelog = read('CHANGELOG.md');
  const heading = new RegExp(`^##\\s*\\[${pkg.version.replace(/\./g, '\\.')}\\]`, 'm');
  if (heading.test(changelog)) {
    check(`CHANGELOG has a section for ${pkg.version}`);
  } else {
    fail(`CHANGELOG has no section for the current version ${pkg.version}`);
  }
}

// --- defaults that exist in two places ------------------------------------------------------------

// A default written both in the manifest and in the code is a value that will eventually disagree
// with itself, and the symptom is behaviour that depends on whether the user happened to set the
// setting explicitly. Compared here rather than left to a comment asking people to keep them in sync.
const { DEFAULT_VARIABLE_PATTERN } = await import('../src/sql/variables.ts');
const declaredPattern = properties['open-dbclient.variables.pattern']?.default;
if (declaredPattern === DEFAULT_VARIABLE_PATTERN) {
  check('the variable pattern default matches the code');
} else {
  fail(
    `the variable pattern default differs: package.json has ${JSON.stringify(declaredPattern)}, ` +
      `src/sql/variables.ts has ${JSON.stringify(DEFAULT_VARIABLE_PATTERN)}`,
  );
}

// --- result ---------------------------------------------------------------------------------------

if (problems.length > 0) {
  console.error(`\n[docs] ${problems.length} problem(s) found`);
  process.exit(1);
}
console.log('[docs] documentation matches the manifest');
