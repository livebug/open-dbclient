/**
 * Reports whether this machine can build and test the project, and what is missing if not.
 *
 * Meant to be the first thing run on a machine with no internet access, where a failed build is
 * expensive to diagnose: there is no `npm install` to fall back on and no documentation to search.
 *
 * The checks are functional where that is cheap. A version comparison would say "Node 24 is required"
 * without saying why; importing a `.ts` file proves whether type stripping - which the test suite
 * relies on - actually works here.
 *
 * Usage:
 *   node scripts/offline-doctor.mjs
 *   node scripts/offline-doctor.mjs --cache ../npm-cache
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cacheArg = process.argv.indexOf('--cache');
const cacheDir = cacheArg === -1 ? undefined : process.argv[cacheArg + 1];

const lines = [];
let failures = 0;
let warnings = 0;

function ok(message, detail = '') {
  lines.push(`  ok    ${message}${detail ? `  ${detail}` : ''}`);
}

function bad(message, advice) {
  failures += 1;
  lines.push(`  FAIL  ${message}`);
  if (advice) {
    lines.push(`        → ${advice}`);
  }
}

function warn(message, advice) {
  warnings += 1;
  lines.push(`  warn  ${message}`);
  if (advice) {
    lines.push(`        → ${advice}`);
  }
}

function section(title) {
  lines.push('');
  lines.push(title);
}

/**
 * Runs a command and returns its combined output, or undefined when it could not be run.
 *
 * The streams are combined deliberately: `java -version` prints to stderr and exits 0, so reading only
 * stdout made a working JDK look like a missing one.
 */
function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) {
    return undefined;
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return output === '' ? undefined : output;
}

/** The major version out of whatever a JDK prints, handling the `1.8.0_392` spelling. */
function javaMajor(output) {
  const quoted = /version "(\d+)(?:\.(\d+))?/.exec(output);
  if (quoted) {
    const first = Number(quoted[1]);
    return first === 1 ? Number(quoted[2] ?? 0) : first;
  }
  const bare = /(?:javac|java)\s+(\d+)/.exec(output);
  return bare ? Number(bare[1]) : undefined;
}

// --- node -----------------------------------------------------------------------------------------

section('Node');

const nodeMajor = Number(process.versions.node.split('.')[0]);
lines.push(`  info  node ${process.version}`);

if (nodeMajor >= 24) {
  ok('Node version is one this project is developed and tested against');
} else if (nodeMajor >= 22) {
  warn(
    'Node is older than the version this project is tested with (24)',
    'It may work, but the test suite runs TypeScript files directly, which needs type stripping.',
  );
} else {
  bad(
    `Node ${process.version} is too old`,
    'The test suite runs .ts files directly, which needs Node 22.6 or newer and works without a flag from 23.6.',
  );
}

// A functional check rather than a version comparison: this is the capability the test suite needs.
const probeDir = mkdtempSync(join(tmpdir(), 'dbclient-doctor-'));
try {
  const probe = join(probeDir, 'probe.ts');
  writeFileSync(probe, 'export const answer: number = 42;\n');
  try {
    const value = await import(pathToFileURL(probe).href);
    if (value.answer === 42) {
      ok(
        'TypeScript files can be imported directly (type stripping works)',
        '(Node prints an experimental warning for this; that is expected)',
      );
    } else {
      bad('The type-stripping probe returned an unexpected value', String(value.answer));
    }
  } catch (error) {
    bad(
      'TypeScript files cannot be imported directly',
      `Needed by \`npm run test:unit\`. ${String(error)}`,
    );
  }
} finally {
  rmSync(probeDir, { recursive: true, force: true });
}

// --- npm ------------------------------------------------------------------------------------------

section('npm');

const npmVersion = capture('npm', ['--version']);
if (npmVersion && /^\d/.test(npmVersion)) {
  ok(`npm ${npmVersion} is available`);
} else {
  bad('npm was not found on PATH', 'Node ships with npm; check that the Node install is complete.');
}

// --- java -----------------------------------------------------------------------------------------

section('Java');

const javaOutput = capture('java', ['-version']);
const javacOutput = capture('javac', ['-version']);
const jarOutput = capture('jar', ['--version']);

if (!javaOutput) {
  bad('java was not found on PATH', 'A JDK 17 or newer is required to build and run the bridge.');
} else {
  lines.push(`  info  ${javaOutput.split('\n')[0]}`);
}

if (!javacOutput) {
  bad('javac was not found on PATH', 'A JRE is not enough; the bridge is compiled from source.');
} else {
  lines.push(`  info  ${javacOutput.split('\n')[0]}`);
  const major = javaMajor(javacOutput);
  if (major === undefined) {
    warn('Could not read the javac version', `Output was: ${javacOutput}`);
  } else if (major >= 17) {
    ok(`javac ${major} satisfies the minimum of 17`);
  } else {
    bad(`javac ${major} is older than the required 17`, 'The bridge targets Java 17 bytecode.');
  }
}

if (!jarOutput) {
  bad('jar was not found on PATH', 'It comes with the JDK and is used to package the bridge.');
}

// --- git ------------------------------------------------------------------------------------------

section('git');

const gitVersion = capture('git', ['--version']);
if (gitVersion) {
  ok(gitVersion);
} else {
  warn('git was not found on PATH', 'Not needed to build, but needed to work on the source.');
}

// --- dependencies ---------------------------------------------------------------------------------

section('Dependencies');

if (existsSync(join(root, 'node_modules'))) {
  ok('node_modules is present, so the build can run');
} else if (cacheDir) {
  if (!existsSync(cacheDir)) {
    bad(`The cache directory ${cacheDir} does not exist`, 'Check the path given to --cache.');
  } else if (!existsSync(join(cacheDir, '_cacache'))) {
    warn(
      `The cache directory ${cacheDir} does not contain an npm cache`,
      'Expected a _cacache folder inside it. Continuing anyway.',
    );
  } else {
    ok(`An npm cache was found at ${cacheDir}`);
  }

  if (existsSync(join(cacheDir, 'PLATFORM.txt'))) {
    const note = readFileSync(join(cacheDir, 'PLATFORM.txt'), 'utf8');
    const builtOn = /on ([\w-]+) with/.exec(note)?.[1];
    const current = `${process.platform}-${process.arch}`;
    if (builtOn && builtOn !== current) {
      bad(
        `The cache was built on ${builtOn} but this machine is ${current}`,
        'Platform-specific binaries are not interchangeable. Use an archive built on this platform.',
      );
    } else if (builtOn) {
      ok(`The cache was built for ${builtOn}, which matches this machine`);
    }
  }
} else {
  warn(
    'node_modules is missing and no --cache was given',
    'Run: npm ci --offline --cache <the npm-cache directory from the bundle>',
  );
}

// --- result ---------------------------------------------------------------------------------------

console.log(lines.join('\n'));
console.log('');

if (failures > 0) {
  console.error(`[doctor] ${failures} problem(s) found${warnings > 0 ? `, ${warnings} warning(s)` : ''}`);
  process.exit(1);
}

console.log(
  `[doctor] This machine can build the project${warnings > 0 ? ` (${warnings} warning(s))` : ''}.`,
);
console.log('[doctor] Next: npm ci --offline --cache <npm-cache>, then npm test');
