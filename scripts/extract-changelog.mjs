/**
 * Prints the CHANGELOG section for one version, so the release workflow can use it as the body of
 * the GitHub Release instead of an auto-generated commit list.
 *
 *   node scripts/extract-changelog.mjs 0.1.0
 *
 * Exits 1 when there is no section for that version, which lets the caller fall back to
 * `gh release create --generate-notes`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!version) {
  console.error('usage: node scripts/extract-changelog.mjs <version>');
  process.exit(2);
}

const changelogPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');

let text;
try {
  text = readFileSync(changelogPath, 'utf8');
} catch {
  console.error(`[changelog] cannot read ${changelogPath}`);
  process.exit(1);
}

const lines = text.split(/\r?\n/);
// The heading may be `## [1.2.3]` or `## [1.2.3] - 2024-01-01`; only the bracketed version matters.
const isHeading = (line) => /^##\s*\[/.test(line);
const startIndex = lines.findIndex((line) => {
  const match = /^##\s*\[([^\]]+)\]/.exec(line);
  return match !== null && match[1].trim().replace(/^v/, '') === version;
});

if (startIndex === -1) {
  console.error(`[changelog] no section found for ${version}`);
  process.exit(1);
}

// Everything up to the next version heading. The link-reference block at the bottom of the file uses
// `[x]: url` rather than `## [x]`, so it cannot be mistaken for a section.
let endIndex = lines.length;
for (let i = startIndex + 1; i < lines.length; i += 1) {
  if (isHeading(lines[i])) {
    endIndex = i;
    break;
  }
}

const body = lines
  .slice(startIndex + 1, endIndex)
  .join('\n')
  .trim();

if (body === '') {
  console.error(`[changelog] section for ${version} is empty`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
