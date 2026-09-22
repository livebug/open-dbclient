import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import * as vscode from 'vscode';

import { Config } from '../constants';
import { Methods } from '../bridge/protocol';
import type { DriverFailure, DriverInfo, DriverRegistrationResult } from '../bridge/protocol';
import type { JdbcBridge } from '../bridge/JdbcBridge';
import { describeError, log } from '../util/logger';

/** Where Maven Central lives. Drivers are fetched from here on request. */
const MAVEN_CENTRAL = 'https://repo1.maven.org/maven2';

/** Guard against scanning a directory that turns out to be a whole disk. */
const MAX_JARS = 200;

/**
 * Finds JDBC driver jars and hands them to the bridge.
 *
 * Drivers are entirely user-supplied: the extension ships none. That is not a limitation so much as
 * the only workable arrangement. Oracle, GaussDB's commercial edition and Transwarp Inceptor are all
 * licence-restricted or absent from public repositories, and pinning versions would mean users
 * could not move to a driver that fixes a bug. The extension therefore provides a folder, scans it,
 * and lets the bridge load whatever is there.
 */
export class DriverManager implements vscode.Disposable {
  private drivers: DriverInfo[] = [];
  private jarPaths: string[] = [];
  private failures: DriverFailure[] = [];
  private registration: Promise<DriverRegistrationResult> | undefined;

  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires after the loaded driver set changes. */
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: JdbcBridge,
  ) {}

  /** The managed folder users drop jars into. */
  get driverFolder(): string {
    return join(this.context.globalStorageUri.fsPath, 'drivers');
  }

  list(): readonly DriverInfo[] {
    return this.drivers;
  }

  listJars(): readonly string[] {
    return this.jarPaths;
  }

  /** Jars that could not be turned into usable drivers, keyed for display. */
  listFailures(): readonly DriverFailure[] {
    return this.failures;
  }

  find(driverClassName: string): DriverInfo | undefined {
    return this.drivers.find((driver) => driver.driverClassName === driverClassName);
  }

  get hasDrivers(): boolean {
    return this.drivers.length > 0;
  }

  /**
   * Re-scans the driver folders and reloads drivers in the bridge.
   *
   * Concurrent callers share one run: several features activating at once would otherwise each
   * trigger a full rescan and classloader rebuild.
   */
  async register(): Promise<DriverRegistrationResult> {
    this.registration ??= this.performRegistration().finally(() => {
      this.registration = undefined;
    });
    return this.registration;
  }

  private async performRegistration(): Promise<DriverRegistrationResult> {
    const jarPaths = await this.collectJars();
    const driverClassNames = vscode.workspace
      .getConfiguration()
      .get<string[]>(Config.driverClassNames, [])
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    log.debug(`Registering ${jarPaths.length} driver jar(s) and ${driverClassNames.length} explicit class name(s)`);

    const result = await this.bridge.request<DriverRegistrationResult>(Methods.driverRegister, {
      jarPaths,
      driverClassNames,
    });

    this.jarPaths = result.jarPaths ?? jarPaths;
    this.drivers = result.drivers ?? [];
    this.failures = result.failures ?? [];

    for (const failure of this.failures) {
      log.warn(
        `Driver not loaded${failure.driverClassName ? ` (${failure.driverClassName})` : ''}` +
          `${failure.jar ? ` from ${failure.jar}` : ''}: ${failure.message}`,
      );
    }
    for (const stale of result.staleDrivers ?? []) {
      log.warn(`Driver '${stale}' was replaced or removed; connections using it were closed`);
    }

    log.info(`Loaded ${this.drivers.length} JDBC driver(s)`);
    this.emitter.fire();
    return result;
  }

  /**
   * Gathers every jar the user has made available.
   *
   * Two sources: the managed folder, and whatever `open-dbclient.driverPaths` points at. Each entry
   * there may be a directory (scanned for jars directly inside it) or a jar file itself. Recursive
   * scanning is deliberately not done - pointing the setting at a Maven cache would otherwise walk
   * tens of thousands of files and take tens of seconds.
   */
  async collectJars(): Promise<string[]> {
    const folders = [this.driverFolder];
    const explicitFiles: string[] = [];

    for (const configured of vscode.workspace.getConfiguration().get<string[]>(Config.driverPaths, [])) {
      const expanded = expandHome(configured.trim());
      if (!expanded) {
        continue;
      }
      if (extname(expanded).toLowerCase() === '.jar') {
        explicitFiles.push(isAbsolute(expanded) ? expanded : resolve(expanded));
      } else {
        folders.push(isAbsolute(expanded) ? expanded : resolve(expanded));
      }
    }

    const found = new Set<string>();
    for (const folder of folders) {
      for (const jar of await listJarsIn(folder)) {
        found.add(jar);
        if (found.size >= MAX_JARS) {
          log.warn(`Stopped after ${MAX_JARS} driver jars; check the 'driverPaths' setting`);
          break;
        }
      }
    }
    for (const file of explicitFiles) {
      if (await isFile(file)) {
        found.add(file);
      } else {
        log.warn(`'driverPaths' entry is not a file: ${file}`);
      }
    }

    return [...found].sort();
  }

  /** Creates the managed driver folder if it does not exist and returns its path. */
  async ensureFolder(): Promise<string> {
    const folder = this.driverFolder;
    await mkdir(folder, { recursive: true });
    return folder;
  }

  /** Opens the managed driver folder in the operating system's file manager. */
  async openFolder(): Promise<void> {
    const folder = await this.ensureFolder();
    const opened = await vscode.env.openExternal(vscode.Uri.file(folder));
    if (!opened) {
      // Headless and remote sessions have no file manager; surfacing the path is the fallback.
      await vscode.window.showInformationMessage(`The JDBC driver folder is at ${folder}`);
    }
  }

  /**
   * Copies jars chosen by the user into the managed folder.
   *
   * Copying rather than referencing keeps the setup portable: the profile only needs to know a
   * driver class name, not where a jar happened to live on one machine.
   */
  async addJars(): Promise<DriverInfo[]> {
    const selection = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: 'Add JDBC driver',
      filters: { 'JDBC driver jar': ['jar'] },
    });
    if (!selection || selection.length === 0) {
      return [];
    }

    const folder = await this.ensureFolder();
    const copied: string[] = [];

    for (const uri of selection) {
      const target = join(folder, basename(uri.fsPath));
      try {
        if (await isFile(target)) {
          const answer = await vscode.window.showWarningMessage(
            `${basename(target)} is already in the driver folder. Replace it?`,
            { modal: true },
            'Replace',
          );
          if (answer !== 'Replace') {
            continue;
          }
        }
        await copyFile(uri.fsPath, target);
        copied.push(target);
        log.info(`Copied driver jar into the driver folder: ${basename(target)}`);
      } catch (error) {
        log.error(error, `Could not copy ${uri.fsPath}`);
        void vscode.window.showErrorMessage(
          `Could not copy ${basename(uri.fsPath)}: ${describeError(error)}`,
        );
      }
    }

    if (copied.length === 0) {
      return [];
    }
    await this.register();
    return [...this.drivers];
  }

  /**
   * Downloads a driver jar from Maven Central by coordinates.
   *
   * Only the requested artifact is fetched. Maven's dependency resolution is not implemented: it
   * would mean parsing POMs and picking a version from a graph, and getting that subtly wrong is
   * worse than the honest alternative. When a driver needs companion jars - sqlite-jdbc needs
   * slf4j-api, for instance - the bridge reports a missing class naming it, and the user can add
   * that jar too.
   */
  async downloadDriver(): Promise<DriverInfo[]> {
    const coordinates = await vscode.window.showInputBox({
      title: 'Download a JDBC driver from Maven Central',
      prompt: 'Coordinates as groupId:artifactId:version. Separate several with spaces or commas.',
      placeHolder: 'org.postgresql:postgresql:42.7.4',
      validateInput: validateCoordinates,
    });
    if (!coordinates) {
      return [];
    }

    const requests = coordinates
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    const folder = await this.ensureFolder();
    const downloaded: string[] = [];

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Downloading JDBC driver' },
      async (progress) => {
        for (const request of requests) {
          const [group, artifact, version] = request.split(':');
          const fileName = `${artifact}-${version}.jar`;
          progress.report({ message: fileName });

          const url = `${MAVEN_CENTRAL}/${group.replace(/\./g, '/')}/${artifact}/${version}/${fileName}`;
          try {
            const response = await fetch(url);
            if (!response.ok) {
              throw new Error(`Maven Central responded with ${response.status} ${response.statusText}`);
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            const target = join(folder, fileName);
            await writeFile(target, bytes);
            downloaded.push(target);
            log.info(`Downloaded ${fileName} (${(bytes.length / 1024).toFixed(0)} KiB) from ${url}`);
          } catch (error) {
            log.error(error, `Could not download ${request}`);
            void vscode.window.showErrorMessage(`Could not download ${request}: ${describeError(error)}`);
          }
        }
      },
    );

    if (downloaded.length === 0) {
      return [];
    }

    const result = await this.register();

    // A jar that downloaded cleanly but fails to load almost always means a missing dependency, and
    // saying so here saves the user from reading a NoClassDefFoundError and guessing.
    for (const failure of result.failures ?? []) {
      if (downloaded.some((jar) => jar === failure.jar)) {
        void vscode.window.showWarningMessage(
          `${basename(failure.jar ?? '')} downloaded but its driver could not load: ${failure.message}. ` +
            'The driver may need additional jars, which can be added with the same download command.',
        );
      }
    }

    return [...this.drivers];
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Expands a leading `~` so settings can use the shorthand users expect. */
function expandHome(path: string): string {
  if (!path) {
    return '';
  }
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

async function listJarsIn(folder: string): Promise<string[]> {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
      .map((entry) => join(folder, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Could not read the driver folder ${folder}: ${describeError(error)}`);
    }
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function validateCoordinates(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Enter at least one groupId:artifactId:version';
  }
  for (const entry of trimmed.split(/[\s,]+/)) {
    const parts = entry.split(':');
    if (parts.length !== 3 || parts.some((part) => part.trim().length === 0)) {
      return `'${entry}' is not groupId:artifactId:version`;
    }
    if (entry.includes('..') || entry.includes('/') || entry.includes('\\')) {
      return `'${entry}' contains characters that are not valid in Maven coordinates`;
    }
  }
  return undefined;
}
