/**
 * Packages the extension into `build/open-dbclient-<version>.vsix`.
 *
 * `vsce` is invoked from the local `node_modules` rather than through a shell alias so that the
 * version used is the one pinned in `package.json`, on every platform. The `build` directory is
 * created here because `vsce --out` does not create missing parents.
 *
 * Running `vsce package` triggers the `vscode:prepublish` script, which typechecks, bundles the
 * extension and compiles the Java bridge in release mode — so the VSIX is always built from source
 * rather than from whatever happens to be lying in `out/`.
 *
 * Options:
 *   --no-verify   skip the `npm test` run that normally precedes packaging
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skipTests = process.argv.includes('--no-verify');

const isWindows = process.platform === 'win32';
const binDir = join(root, 'node_modules', '.bin');
const vsce = join(binDir, isWindows ? 'vsce.cmd' : 'vsce');

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
  });
  if (result.error) {
    console.error(`[package] ${label} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[package] ${label} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(vsce)) {
  console.error('[package] vsce is not installed. Run `npm install` first.');
  process.exit(1);
}

if (!skipTests) {
  console.log('[package] running the test suite first\n');
  run('npm', ['test'], 'npm test');
  console.log('');
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outputDir = join(root, 'build');
const outputPath = join(outputDir, `open-dbclient-${version}.vsix`);

mkdirSync(outputDir, { recursive: true });

console.log(`[package] building open-dbclient ${version}`);
run(vsce, ['package', '--out', outputPath], 'vsce package');

if (!existsSync(outputPath)) {
  console.error(`[package] vsce reported success but ${outputPath} does not exist`);
  process.exit(1);
}

const sizeMib = statSync(outputPath).size / (1024 * 1024);
console.log(`\n[package] wrote ${resolve(outputPath)} (${sizeMib.toFixed(2)} MiB)`);

// The VSIX must contain a URI-stable manifest and the compiled bridge; an empty or tiny archive
// almost always means the .vscodeignore rules excluded something the extension needs at runtime.
if (sizeMib < 0.05) {
  console.error('[package] the VSIX is suspiciously small — check .vscodeignore');
  process.exit(1);
}
