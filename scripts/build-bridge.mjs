#!/usr/bin/env node
/**
 * Builds the JDBC bridge jar with plain `javac` + `jar`.
 *
 * The bridge has zero third-party dependencies, so a build tool would buy nothing but
 * required installing one. Everything it needs ships with the JDK.
 *
 * Usage:
 *   node scripts/build-bridge.mjs             # build resources/bridge.jar
 *   node scripts/build-bridge.mjs --release   # same, without debug info
 *   node scripts/build-bridge.mjs --test      # compile and run the bridge test suite
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mainSourcesDir = join(root, 'bridge/src/main/java');
const testSourcesDir = join(root, 'bridge/src/test/java');
const buildDir = join(root, 'bridge/out');
const mainClassesDir = join(buildDir, 'classes');
const testClassesDir = join(buildDir, 'test-classes');
const jarPath = join(root, 'resources/bridge.jar');

const MAIN_CLASS = 'com.opendbclient.bridge.BridgeMain';
const TEST_CLASS = 'com.opendbclient.bridge.BridgeTests';
const TARGET_RELEASE = '17';

const runTests = process.argv.includes('--test');
const release = process.argv.includes('--release');

/** Recursively collects `.java` files. */
function collectJavaFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectJavaFiles(full));
    } else if (entry.endsWith('.java')) {
      found.push(full);
    }
  }
  return found.sort();
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', cwd: root, ...options });
}

/**
 * Verifies a JDK tool is usable.
 *
 * The version flag differs per tool: `javac` accepts `-version`, while `jar` only accepts
 * the long form and exits non-zero on `-version`.
 */
function assertToolAvailable(tool, versionFlag) {
  try {
    execFileSync(tool, [versionFlag], { stdio: 'ignore' });
  } catch {
    console.error(
      `\n[bridge] '${tool}' was not found or is not usable.\n` +
        `[bridge] A JDK ${TARGET_RELEASE}+ is required to build the bridge.\n` +
        `[bridge] If a JDK is installed elsewhere, add its bin directory to PATH.\n`,
    );
    process.exit(1);
  }
}

function main() {
  assertToolAvailable('javac', '-version');
  assertToolAvailable('jar', '--version');

  const mainSources = collectJavaFiles(mainSourcesDir);
  if (mainSources.length === 0) {
    console.error(`[bridge] no Java sources found under ${mainSourcesDir}`);
    process.exit(1);
  }

  // Clean rather than incremental: javac leaves class files behind for sources that have
  // been deleted or renamed, and those stale classes would silently ship inside the jar.
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(mainClassesDir, { recursive: true });

  const javacArgs = [
    '--release',
    TARGET_RELEASE,
    '-encoding',
    'UTF-8',
    '-Xlint:all,-serial',
    '-d',
    mainClassesDir,
  ];
  if (release) {
    javacArgs.push('-g:none');
  }

  console.log(`[bridge] compiling ${mainSources.length} source files (target Java ${TARGET_RELEASE})`);
  run('javac', [...javacArgs, ...mainSources]);

  if (runTests) {
    const testSources = collectJavaFiles(testSourcesDir);
    if (testSources.length === 0) {
      console.error(`[bridge] --test was passed but no tests exist under ${testSourcesDir}`);
      process.exit(1);
    }
    mkdirSync(testClassesDir, { recursive: true });
    console.log(`[bridge] compiling ${testSources.length} test files`);
    run('javac', [
      '--release',
      TARGET_RELEASE,
      '-encoding',
      'UTF-8',
      '-Xlint:all,-serial',
      '-cp',
      mainClassesDir,
      '-d',
      testClassesDir,
      ...testSources,
    ]);

    console.log('[bridge] running tests\n');
    run('java', ['-cp', `${mainClassesDir}${process.platform === 'win32' ? ';' : ':'}${testClassesDir}`, TEST_CLASS]);
    console.log('\n[bridge] tests passed');
    return;
  }

  // The manifest needs an explicit main class so `java -jar` works without a classpath.
  console.log(`[bridge] packaging ${relative(root, jarPath)}`);
  run('jar', [
    '--create',
    '--file',
    jarPath,
    '--main-class',
    MAIN_CLASS,
    '-C',
    mainClassesDir,
    '.',
  ]);

  const sizeKb = (statSync(jarPath).size / 1024).toFixed(1);
  console.log(`[bridge] built ${relative(root, jarPath)} (${sizeKb} KiB)`);
}

main();
