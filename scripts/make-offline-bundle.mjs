/**
 * Builds a self-contained archive for developing this project on a network with no internet access.
 *
 * The only step in this project that needs the network is `npm install`. Everything else - the Java
 * bridge, the extension bundle, the tests, packaging - is local, which was verified by running the
 * whole pipeline with the registry and proxy pointed at a dead port.
 *
 * So the archive carries exactly what makes `npm ci` work offline, plus the built artifacts, plus the
 * procedure:
 *
 *   source/      the repository at HEAD, from `git archive` (so it is a commit, not a working tree)
 *   npm-cache/   an npm cache holding the tarballs in package-lock.json, which is 31 MB or so -
 *                far less than the 300 MB of node_modules it installs, and it still resolves
 *                optional dependencies correctly
 *   prebuilt/    bridge.jar and the webview bundles, so the archive can be tried before it is built
 *   drivers/     any JDBC jars passed with --drivers, so the end-to-end checks can run offline
 *   OFFLINE.md   the procedure, written for whoever receives the archive
 *   MANIFEST.txt what is inside, which commit, which platform, and which toolchain built it
 *
 * Usage:
 *   node scripts/make-offline-bundle.mjs
 *   node scripts/make-offline-bundle.mjs --drivers /tmp/dbclient-drivers
 *   node scripts/make-offline-bundle.mjs --no-cache      # source + prebuilt only
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outputDir = join(root, 'build');
const stagingRoot = join(root, '.build', 'offline-bundle');

const withCache = !process.argv.includes('--no-cache');
const driversArg = process.argv.indexOf('--drivers');
const driversDir = driversArg === -1 ? undefined : process.argv[driversArg + 1];

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const platform = `${process.platform}-${process.arch}`;
const archivePath = join(outputDir, `open-dbclient-offline-${version}-${platform}.tar.gz`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) {
    console.error(`\n[bundle] ${command} ${args.join(' ')} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

/**
 * Runs a command that has to reach the network, and explains itself when it cannot.
 *
 * Building the archive is the one part of this project that genuinely needs the internet: it downloads
 * the tarballs the archive will carry. A machine that is already air-gapped, or a shell that still has
 * an offline npm configuration exported, will fail here - and the failure would otherwise look like a
 * broken script rather than a missing network.
 */
function runOnline(command, args, options, what) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status === 0) {
    return;
  }

  const offlineEnv = Object.keys(process.env).filter(
    (name) => /^(npm_config_offline|npm_config_registry|npm_config_prefer_offline|http_proxy|https_proxy|all_proxy)$/i.test(name),
  );
  console.error(`\n[bundle] ${what} failed, and this step needs network access.`);
  if (offlineEnv.length > 0) {
    console.error(`        These variables are set and may be the reason: ${offlineEnv.join(', ')}`);
    console.error('        Unset them and try again.');
  } else {
    console.error('        Check that this machine can reach its npm registry.');
  }
  process.exit(result.status ?? 1);
}

function capture(command, args, cwd = root) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}

/** Every file under a directory, as paths relative to it. */
function walk(dir, base = dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(full, base));
    } else if (entry.isFile()) {
      found.push(relative(base, full));
    }
  }
  return found.sort();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function describe(path) {
  return `${(statSync(path).size / 1024).toFixed(1)} KiB`;
}

// --- preflight ------------------------------------------------------------------------------------

const commit = capture('git', ['rev-parse', 'HEAD']);
const commitShort = capture('git', ['rev-parse', '--short', 'HEAD']);
const dirty = capture('git', ['status', '--porcelain']) !== '';

if (dirty) {
  console.warn(
    '\n[bundle] The working tree has uncommitted changes. `git archive HEAD` is used, so those ' +
      'changes will NOT be in the archive. Commit them first if they matter.\n',
  );
}

console.log(`[bundle] open-dbclient ${version} (${commitShort}) for ${platform}`);

// --- staging --------------------------------------------------------------------------------------

rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });

// `git archive` rather than a copy: the archive should be a commit, not whatever happens to be lying
// around, and it excludes generated files by construction.
const sourceDir = join(stagingRoot, 'source');
mkdirSync(sourceDir, { recursive: true });
run('git', ['archive', '--format=tar', `--output=${join(stagingRoot, 'source.tar')}`, 'HEAD']);
run('tar', ['-xf', join(stagingRoot, 'source.tar'), '-C', sourceDir]);
rmSync(join(stagingRoot, 'source.tar'));
console.log(`[bundle] source extracted to the staging area (${walk(sourceDir).length} files)`);

// --- npm cache ------------------------------------------------------------------------------------

if (withCache) {
  const cacheDir = join(stagingRoot, 'npm-cache');
  console.log('[bundle] installing dependencies to populate the npm cache');
  runOnline(
    'npm',
    ['ci', '--cache', cacheDir, '--loglevel=error'],
    { cwd: sourceDir },
    'Downloading the dependencies',
  );

  // The installed tree is only a means to fill the cache; the archive carries the cache instead, which
  // is about a tenth of the size and is what `npm ci --offline` actually reads. node_modules stays for
  // now, because the build below needs it, and is removed once the artifacts exist.

  // esbuild's optional platform package is a binary, so a cache built on one platform does not serve
  // another. Saying so here is cheaper than the confusing failure it would otherwise cause.
  writeFileSync(
    join(cacheDir, 'PLATFORM.txt'),
    `This cache was populated on ${platform} with Node ${process.version}.\n\n` +
      `It contains the platform-specific optional dependencies for that platform only, so\n` +
      `\`npm ci --offline\` with it will fail on a different OS or CPU architecture. Build the\n` +
      `archive on a machine that matches the target, or produce one archive per target platform.\n`,
  );
  console.log(`[bundle] npm cache populated (${walk(cacheDir).length} files)`);
} else {
  console.log('[bundle] --no-cache: reusing this checkout\'s node_modules to build');
  cpSync(join(root, 'node_modules'), join(sourceDir, 'node_modules'), { recursive: true });
}

// --- prebuilt artifacts ---------------------------------------------------------------------------

// Built here so the archive contains something runnable, and so a target machine without a JDK can
// still package the extension.
console.log('[bundle] building the bridge and the extension bundles');
run('node', ['scripts/build-bridge.mjs', '--release'], { cwd: sourceDir });
run('node', ['esbuild.mjs', '--release'], { cwd: sourceDir });

const prebuiltDir = join(stagingRoot, 'prebuilt');
mkdirSync(join(prebuiltDir, 'media', 'result'), { recursive: true });
mkdirSync(join(prebuiltDir, 'media', 'connection'), { recursive: true });
mkdirSync(join(prebuiltDir, 'resources'), { recursive: true });

const prebuiltFiles = [
  ['resources/bridge.jar', 'resources/bridge.jar'],
  ['out/extension.js', 'out/extension.js'],
  ['media/result/main.js', 'media/result/main.js'],
  ['media/connection/main.js', 'media/connection/main.js'],
];
for (const [from, to] of prebuiltFiles) {
  const source = join(sourceDir, from);
  if (!existsSync(source)) {
    console.error(`[bundle] expected the build to produce ${from}`);
    process.exit(1);
  }
  mkdirSync(dirname(join(prebuiltDir, to)), { recursive: true });
  copyFileSync(source, join(prebuiltDir, to));
}
rmSync(join(sourceDir, 'node_modules'), { recursive: true, force: true });

// --- drivers --------------------------------------------------------------------------------------

if (driversDir) {
  if (!existsSync(driversDir)) {
    console.error(`[bundle] --drivers ${driversDir} does not exist`);
    process.exit(1);
  }
  const jars = readdirSync(driversDir).filter((name) => name.toLowerCase().endsWith('.jar'));
  if (jars.length === 0) {
    console.error(`[bundle] --drivers ${driversDir} contains no .jar files`);
    process.exit(1);
  }
  const target = join(stagingRoot, 'drivers');
  mkdirSync(target, { recursive: true });
  for (const jar of jars) {
    copyFileSync(join(driversDir, jar), join(target, jar));
  }
  console.log(`[bundle] included ${jars.length} driver jar(s) for the offline end-to-end checks`);
}

// --- documentation shipped with the archive -------------------------------------------------------

// Taken from the staged source rather than the working tree, so that the instructions and the code
// they describe come from the same commit. Reading it from the working tree would ship documentation
// that the archive's own source does not match.
const shippedDoc = join(sourceDir, 'docs', 'offline.md');
if (!existsSync(shippedDoc)) {
  console.error(
    '[bundle] docs/offline.md is not in the commit, so the archive would arrive with no instructions.\n' +
      '         Commit it first.',
  );
  process.exit(1);
}
copyFileSync(shippedDoc, join(stagingRoot, 'OFFLINE.md'));

// --- manifest -------------------------------------------------------------------------------------

const lines = [
  `open-dbclient offline development bundle`,
  ``,
  `Version      ${version}`,
  `Commit       ${commit}${dirty ? '  (working tree had uncommitted changes, which are NOT included)' : ''}`,
  `Platform     ${platform}`,
  `Built with   Node ${process.version}, npm ${capture('npm', ['--version'])}, ` +
    `${capture('javac', ['-version'])}`,
  `Built at     ${new Date().toISOString()}`,
  ``,
  `Contents`,
  `  source/      the repository at the commit above (${walk(join(stagingRoot, 'source')).length} files)`,
];
if (withCache) {
  lines.push(`  npm-cache/   npm cache for \`npm ci --offline\`, populated on ${platform}`);
}
lines.push(`  prebuilt/    build output, so the archive can be tried before it is built`);
if (existsSync(join(stagingRoot, 'drivers'))) {
  lines.push(`  drivers/     JDBC jars for the offline end-to-end checks`);
}
lines.push(`  OFFLINE.md   the procedure`);
lines.push(``);
lines.push(`Key artifacts (sha256)`);
for (const [to] of prebuiltFiles) {
  const path = join(prebuiltDir, to);
  lines.push(`  ${sha256(path)}  ${to}  (${describe(path)})`);
}
lines.push(``);
lines.push(`Read OFFLINE.md first. It takes about ten minutes to a working build.`);
lines.push(``);

writeFileSync(join(stagingRoot, 'MANIFEST.txt'), lines.join('\n'));

// --- archive --------------------------------------------------------------------------------------

mkdirSync(outputDir, { recursive: true });
rmSync(archivePath, { force: true });
run('tar', ['-czf', archivePath, '-C', stagingRoot, '.']);

const size = (statSync(archivePath).size / (1024 * 1024)).toFixed(1);
console.log(`\n[bundle] ${relative(root, archivePath)} (${size} MiB)`);
console.log(`[bundle] sha256 ${sha256(archivePath)}`);
console.log('[bundle] unpack it and follow OFFLINE.md on the target machine\n');
