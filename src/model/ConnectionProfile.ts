import type { DatabaseCapabilities } from '../bridge/protocol';

/**
 * A saved connection.
 *
 * There is deliberately no database-type field. A profile is a driver class name, a JDBC URL and
 * credentials, which is the complete set of things the bridge needs. Adding a type would invite
 * per-database branches throughout the extension and defeat the point of using JDBC.
 */
export interface ConnectionProfile {
  readonly id: string;
  readonly name: string;
  /** Fully qualified `java.sql.Driver` implementation. */
  readonly driverClassName: string;
  /** JDBC URL, passed to the driver unchanged. */
  readonly url: string;
  readonly user?: string;
  /** Extra driver properties, forwarded verbatim. */
  readonly properties?: Readonly<Record<string, string>>;
  /** Pool ceiling for this profile; defaults to the global setting. */
  readonly poolSize?: number;
  /** Whether a password is kept in secret storage for this profile. */
  readonly savePassword: boolean;
  /** Optional status bar / tree accent colour. */
  readonly color?: string;
}

/** Everything about a saved profile except its credentials and identity. */
export type ConnectionProfileDraft = Omit<ConnectionProfile, 'id'> & { readonly id?: string };

/** Connection lifecycle as the extension sees it. Not persisted. */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Live state of a profile, held in memory only. */
export interface ConnectionState {
  readonly status: ConnectionStatus;
  readonly capabilities?: DatabaseCapabilities;
  readonly lastError?: string;
  readonly connectedAt?: number;
  /** Milliseconds spent establishing the connection, for display. */
  readonly connectMillis?: number;
}

/** Sensible starting point for a new profile. */
export function emptyProfile(): ConnectionProfileDraft {
  return {
    name: '',
    driverClassName: '',
    url: '',
    user: '',
    properties: {},
    savePassword: true,
  };
}

/**
 * Repairs a profile read from disk.
 *
 * The storage file is plain JSON in a user-visible directory, so it will eventually be hand-edited.
 * Returning a usable record rather than throwing keeps one malformed entry from making every saved
 * connection disappear.
 */
export function normalizeProfile(raw: unknown): ConnectionProfile | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;

  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const driverClassName = typeof record.driverClassName === 'string' ? record.driverClassName.trim() : '';
  const url = typeof record.url === 'string' ? record.url.trim() : '';
  if (!id || !driverClassName || !url) {
    return undefined;
  }

  const properties: Record<string, string> = {};
  if (typeof record.properties === 'object' && record.properties !== null) {
    for (const [key, value] of Object.entries(record.properties as Record<string, unknown>)) {
      if (value !== null && value !== undefined) {
        properties[key] = String(value);
      }
    }
  }

  const poolSize = typeof record.poolSize === 'number' && Number.isFinite(record.poolSize)
    ? Math.max(1, Math.min(32, Math.trunc(record.poolSize)))
    : undefined;

  return {
    id,
    // A profile without a name is unusable in a tree view, so fall back to something identifying.
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : url,
    driverClassName,
    url,
    user: typeof record.user === 'string' && record.user ? record.user : undefined,
    properties,
    poolSize,
    savePassword: record.savePassword !== false,
    color: typeof record.color === 'string' && record.color ? record.color : undefined,
  };
}

/** The name shown for a profile in the tree and in pickers. */
export function profileLabel(profile: ConnectionProfile): string {
  return profile.name || profile.url;
}
