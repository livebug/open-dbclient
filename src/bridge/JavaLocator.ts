import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

import { Config, MINIMUM_JAVA_VERSION } from '../constants';
import { describeError, log } from '../util/logger';

const execFileAsync = promisify(execFile);

/** A usable Java installation. */
export interface JavaRuntime {
  readonly executable: string;
  /** Version string exactly as the JVM reported it. */
  readonly version: string;
  readonly majorVersion: number;
  /** Where the executable was found, for diagnostics. */
  readonly source: 'setting' | 'JAVA_HOME' | 'PATH';
}

/** Raised when no Java new enough to run the bridge could be found. */
export class JavaNotFoundError extends Error {
  constructor(readonly guidance: string) {
    super('No suitable Java installation was found.');
    this.name = 'JavaNotFoundError';
  }
}

/**
 * Parses a major version out of `java -version` output.
 *
 * Exported because the format has changed over time and getting it wrong silently disables the
 * extension for everyone on an older JDK:
 *
 * ```
 * java version "1.8.0_392"          // Java 8 and earlier, note the leading 1
 * openjdk version "21.0.11"         // Java 9 and later, on stderr
 * openjdk 21.0.11 2026-04-21        // `java --version`, on stdout
 * ```
 */
export function parseJavaVersion(output: string): { major: number; version: string } | undefined {
  const quoted = /version\s+"([^"]+)"/.exec(output);
  const bare = /^(?:openjdk|java)\s+(\d[\w.+-]*)/m.exec(output);
  const raw = quoted?.[1] ?? bare?.[1];
  if (!raw) {
    return undefined;
  }

  const parts = raw.split(/[._+-]/);
  let major = Number(parts[0]);
  if (major === 1 && parts.length > 1) {
    // 1.8.0_392 is Java 8, not Java 1.
    major = Number(parts[1]);
  }
  if (!Number.isInteger(major) || major <= 0) {
    return undefined;
  }
  return { major, version: raw };
}

/** Builds the `java` executable path for a JDK home directory. */
export function javaExecutable(javaHome: string): string {
  const binary = process.platform === 'win32' ? 'java.exe' : 'java';
  // A user may point the setting at either the home directory or the binary itself.
  if (/[\\/]bin[\\/](java|java\.exe)$/i.test(javaHome)) {
    return javaHome;
  }
  return join(javaHome, 'bin', binary);
}

/**
 * Finds a Java installation capable of running the bridge.
 *
 * Candidates are tried in order of how explicit they are - a user's configured path beats the
 * environment, which beats whatever happens to be on `PATH`. Every candidate is probed rather than
 * trusted, because a stale `JAVA_HOME` pointing at an uninstalled JDK is common and would otherwise
 * produce a confusing spawn failure later.
 *
 * @throws JavaNotFoundError with guidance naming each location that was checked
 */
export async function locateJava(): Promise<JavaRuntime> {
  const configuredHome = vscode.workspace.getConfiguration().get<string>(Config.javaHome, '').trim();
  const environmentHome = (process.env.JAVA_HOME ?? '').trim();

  const candidates: Array<{ executable: string; source: JavaRuntime['source'] }> = [];
  if (configuredHome) {
    candidates.push({ executable: javaExecutable(configuredHome), source: 'setting' });
  }
  if (environmentHome) {
    candidates.push({ executable: javaExecutable(environmentHome), source: 'JAVA_HOME' });
  }
  candidates.push({ executable: 'java', source: 'PATH' });

  const rejected: string[] = [];
  for (const candidate of candidates) {
    const runtime = await probeJava(candidate.executable, candidate.source);
    if (!runtime) {
      rejected.push(`${candidate.executable} (${candidate.source}) could not be run`);
      continue;
    }
    if (runtime.majorVersion < MINIMUM_JAVA_VERSION) {
      rejected.push(
        `${candidate.executable} (${candidate.source}) is Java ${runtime.majorVersion}, ` +
          `and version ${MINIMUM_JAVA_VERSION} or newer is required`,
      );
      continue;
    }
    log.info(`Using Java ${runtime.version} from ${candidate.source} (${runtime.executable})`);
    return runtime;
  }

  throw new JavaNotFoundError(buildGuidance(rejected));
}

/**
 * Runs `java -version` and parses the result.
 *
 * Every JDK writes this to stderr, and some exit non-zero for unrelated reasons, so the error path
 * is inspected for version text too rather than treating a non-zero exit as "not Java".
 */
async function probeJava(
  executable: string,
  source: JavaRuntime['source'],
): Promise<JavaRuntime | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ['-version'], {
      timeout: 10_000,
      windowsHide: true,
    });
    return toRuntime(executable, source, `${stdout}\n${stderr}`);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    if (typeof stderr === 'string') {
      const runtime = toRuntime(executable, source, stderr);
      if (runtime) {
        return runtime;
      }
    }
    log.debug(`Java probe of '${executable}' failed: ${describeError(error)}`);
    return undefined;
  }
}

function toRuntime(
  executable: string,
  source: JavaRuntime['source'],
  output: string,
): JavaRuntime | undefined {
  const parsed = parseJavaVersion(output);
  return parsed ? { executable, source, version: parsed.version, majorVersion: parsed.major } : undefined;
}

function buildGuidance(rejected: readonly string[]): string {
  const checks = rejected.length > 0
    ? rejected.map((line) => `  - ${line}`).join('\n')
    : '  - no candidates were available';

  return [
    `Open DB Client needs Java ${MINIMUM_JAVA_VERSION} or newer to run its JDBC bridge.`,
    '',
    'Checked:',
    checks,
    '',
    'Fix this by installing a JDK and either adding it to PATH, setting JAVA_HOME, or pointing the',
    `'open-dbclient.javaHome' setting at the installation directory.`,
  ].join('\n');
}
