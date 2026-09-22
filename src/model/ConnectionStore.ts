import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';

import { log } from '../util/logger';
import {
  normalizeProfile,
  profileLabel,
  type ConnectionProfile,
  type ConnectionProfileDraft,
} from './ConnectionProfile';

const STORAGE_FILE = 'connections.json';
const STORAGE_VERSION = 1;
const SECRET_PREFIX = 'open-dbclient.password.';

/**
 * Persistence for saved connections.
 *
 * Two stores with different characteristics are used together, which is the point:
 *
 * - **Profiles** go to a JSON file in global storage. They are not secret, users benefit from being
 *   able to read and copy them, and they need to travel with a settings sync.
 * - **Passwords** go to {@link vscode.SecretStorage}, which is backed by the operating system
 *   keychain. Writing them into the JSON file would put them in plain text on disk and into any
 *   backup or sync of that directory.
 *
 * The password is therefore never part of a {@link ConnectionProfile}; it is fetched separately at
 * connect time.
 */
export class ConnectionStore implements vscode.Disposable {
  private profiles: ConnectionProfile[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();

  /** Fires after any change to the saved profiles. */
  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Reads profiles from disk. Safe to call more than once. */
  async load(): Promise<void> {
    const file = this.storagePath();
    try {
      const text = await readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(text);
      const entries = extractEntries(parsed);
      this.profiles = entries
        .map(normalizeProfile)
        .filter((profile): profile is ConnectionProfile => profile !== undefined);
      log.info(`Loaded ${this.profiles.length} saved connection(s)`);

      if (this.profiles.length !== entries.length) {
        log.warn(
          `${entries.length - this.profiles.length} saved connection(s) were unusable and have been ignored`,
        );
      }
    } catch (error) {
      if (isMissingFile(error)) {
        this.profiles = [];
        return;
      }
      // A corrupt file must not take the extension down. It is left untouched so the user can
      // recover it by hand, and the session continues with no saved connections.
      log.error(error, `Could not read ${file}; continuing without saved connections`);
      this.profiles = [];
      void vscode.window.showWarningMessage(
        `Open DB Client could not read its saved connections (${file}). The file was left as-is; ` +
          'no connections are available until it is fixed or removed.',
      );
    }
  }

  list(): readonly ConnectionProfile[] {
    return this.profiles;
  }

  find(id: string): ConnectionProfile | undefined {
    return this.profiles.find((profile) => profile.id === id);
  }

  /**
   * Looks up a profile by name, falling back to a case-insensitive match.
   *
   * Used by the `-- @connection` directive, where a user is more likely to write a human name than
   * the generated identifier.
   */
  findByName(name: string): ConnectionProfile | undefined {
    const needle = name.trim();
    if (!needle) {
      return undefined;
    }
    return (
      this.profiles.find((profile) => profile.id === needle) ??
      this.profiles.find((profile) => profileLabel(profile) === needle) ??
      this.profiles.find((profile) => profileLabel(profile).toLowerCase() === needle.toLowerCase())
    );
  }

  async add(draft: ConnectionProfileDraft): Promise<ConnectionProfile> {
    const profile: ConnectionProfile = { ...draft, id: draft.id ?? randomUUID() } as ConnectionProfile;
    this.profiles = [...this.profiles, profile];
    await this.persist();
    log.info(`Added connection '${profileLabel(profile)}'`);
    return profile;
  }

  async update(draft: ConnectionProfileDraft & { id: string }): Promise<ConnectionProfile> {
    const existing = this.find(draft.id);
    if (!existing) {
      throw new Error(`No saved connection with id '${draft.id}'`);
    }
    const updated = { ...existing, ...draft } as ConnectionProfile;
    this.profiles = this.profiles.map((profile) => (profile.id === updated.id ? updated : profile));
    await this.persist();
    log.info(`Updated connection '${profileLabel(updated)}'`);
    return updated;
  }

  async remove(id: string): Promise<void> {
    const existing = this.find(id);
    if (!existing) {
      return;
    }
    this.profiles = this.profiles.filter((profile) => profile.id !== id);
    await this.deletePassword(id);
    await this.persist();
    log.info(`Removed connection '${profileLabel(existing)}'`);
  }

  // ------------------------------------------------------------------
  // credentials
  // ------------------------------------------------------------------

  getPassword(id: string): Thenable<string | undefined> {
    return this.context.secrets.get(SECRET_PREFIX + id);
  }

  setPassword(id: string, password: string): Thenable<void> {
    return this.context.secrets.store(SECRET_PREFIX + id, password);
  }

  deletePassword(id: string): Thenable<void> {
    return this.context.secrets.delete(SECRET_PREFIX + id);
  }

  // ------------------------------------------------------------------
  // storage
  // ------------------------------------------------------------------

  storagePath(): string {
    return join(this.context.globalStorageUri.fsPath, STORAGE_FILE);
  }

  /**
   * Writes the profiles atomically.
   *
   * A rename is used rather than writing in place so an interrupted write leaves the previous file
   * intact. Losing saved connections to a crash during save would be a nasty surprise, and the
   * window between truncate and write is real.
   */
  private async persist(): Promise<void> {
    const file = this.storagePath();
    const temporary = `${file}.tmp`;
    const payload = JSON.stringify(
      {
        version: STORAGE_VERSION,
        connections: this.profiles,
      },
      null,
      2,
    );

    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, payload, 'utf8');
    await rename(temporary, file);

    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Accepts both the versioned wrapper and a bare array, so a hand-written file still loads. */
function extractEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const connections = (parsed as { connections?: unknown }).connections;
    if (Array.isArray(connections)) {
      return connections;
    }
  }
  return [];
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
