import * as vscode from 'vscode';

import { Config, ContextKeys } from '../constants';
import { Methods } from '../bridge/protocol';
import type { JdbcBridge } from '../bridge/JdbcBridge';
import type {
  ConnectionProfileParams,
  DatabaseCapabilities,
  ProbeResult,
} from '../bridge/protocol';
import { describeError, log } from '../util/logger';
import type { ConnectionProfile, ConnectionState } from '../model/ConnectionProfile';
import type { ConnectionStore } from '../model/ConnectionStore';

/** A connection could not be established or was rejected by the database. */
export class ConnectionFailedError extends Error {
  constructor(
    readonly profileId: string,
    message: string,
    /** True when the failure is a missing password rather than a database rejection. */
    readonly needsCredentials = false,
  ) {
    super(message);
    this.name = 'ConnectionFailedError';
  }
}

/**
 * Tracks which profiles are connected and brokers open/close.
 *
 * State lives here rather than in the tree so that every consumer - tree, status bar, SQL editor,
 * health panel - sees one consistent answer to "is this connected", and so the answer survives a
 * tree refresh.
 */
export class ConnectionService implements vscode.Disposable {
  private readonly states = new Map<string, ConnectionState>();
  private readonly emitter = new vscode.EventEmitter<string>();
  private readonly subscriptions: vscode.Disposable[] = [];

  /** Fires with the profile id whose state changed. */
  readonly onDidChangeState = this.emitter.event;

  constructor(
    private readonly bridge: JdbcBridge,
    private readonly store: ConnectionStore,
  ) {
    // When the bridge process is replaced, every connection it held is gone with it. Keeping stale
    // "connected" states would make the tree try to query a process that has never heard of them.
    this.subscriptions.push(
      this.bridge.onDidChangeState((state) => {
        if (state === 'stopped' || state === 'failed' || state === 'starting') {
          this.resetAll();
        }
      }),
    );
  }

  getState(profileId: string): ConnectionState {
    return this.states.get(profileId) ?? { status: 'disconnected' };
  }

  isConnected(profileId: string): boolean {
    return this.getState(profileId).status === 'connected';
  }

  /** Ids of every profile currently connected. */
  connectedIds(): string[] {
    return [...this.states.entries()]
      .filter(([, state]) => state.status === 'connected')
      .map(([id]) => id);
  }

  /**
   * Connects a profile, prompting for a password when one is needed.
   *
   * @throws ConnectionFailedError, after reporting the failure to the user unless `silent`
   */
  async connect(profile: ConnectionProfile, options?: { silent?: boolean }): Promise<ProbeResult> {
    try {
      return await this.openWithStoredCredentials(profile, options?.silent !== true);
    } catch (error) {
      if (error instanceof ConnectionFailedError && error.needsCredentials) {
        const prompted = await this.promptForPassword(profile);
        if (prompted === undefined) {
          throw error;
        }
        return this.open(profile, prompted, options?.silent !== true);
      }
      throw error;
    }
  }

  /** Connects using a password supplied by the caller, bypassing stored credentials. */
  async open(profile: ConnectionProfile, password: string | undefined, report = true): Promise<ProbeResult> {
    this.setState(profile.id, { status: 'connecting' });
    try {
      const result = await this.bridge.request<ProbeResult>(
        Methods.connectionOpen,
        this.toParams(profile, password),
      );
      this.setState(profile.id, {
        status: 'connected',
        capabilities: result.capabilities,
        connectedAt: Date.now(),
        connectMillis: result.connectMillis,
      });
      log.info(`Connected '${profile.name}' in ${result.connectMillis} ms: ${result.capabilities.description}`);
      return result;
    } catch (error) {
      const message = describeError(error);
      this.setState(profile.id, { status: 'error', lastError: message });
      if (report) {
        void vscode.window.showErrorMessage(`Could not connect to '${profile.name}': ${message}`);
      }
      throw error;
    }
  }

  /**
   * Validates a profile without registering it.
   *
   * Used by the connection form, where the profile may not even be saved yet.
   */
  async test(
    profile: ConnectionProfile,
    password: string | undefined,
  ): Promise<ProbeResult> {
    return this.bridge.request<ProbeResult>(
      Methods.connectionTest,
      this.toParams(profile, password),
      // Testing is interactive and a wrong host can hang for a long time; fail before the user
      // gives up and retries.
      { timeoutMs: 60_000 },
    );
  }

  async disconnect(profileId: string): Promise<void> {
    try {
      await this.bridge.request(Methods.connectionClose, { connectionId: profileId });
    } catch (error) {
      // A failure here usually means the bridge is already gone, which has the same outcome.
      log.debug(`Closing connection '${profileId}' failed: ${describeError(error)}`);
    } finally {
      this.setState(profileId, { status: 'disconnected' });
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(this.connectedIds().map((id) => this.disconnect(id)));
  }

  /** The capabilities of a connected profile, if it has been connected at least once. */
  capabilities(profileId: string): DatabaseCapabilities | undefined {
    return this.states.get(profileId)?.capabilities;
  }

  /** Asks for a password and offers to remember it. Returns undefined when the user cancels. */
  async promptForPassword(profile: ConnectionProfile): Promise<string | undefined> {
    const password = await vscode.window.showInputBox({
      title: `Password for ${profile.name}`,
      prompt: profile.user ? `User ${profile.user}` : undefined,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) {
      return undefined;
    }

    // Only offer to save when the profile is one that would read it back.
    if (profile.savePassword && !(await this.store.getPassword(profile.id))) {
      const answer = await vscode.window.showQuickPick(['Remember', 'Do not remember'], {
        title: 'Remember this password?',
        placeHolder: 'Stored in the operating system keychain',
      });
      if (answer === 'Remember') {
        await this.store.setPassword(profile.id, password);
      }
    }
    return password;
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private async openWithStoredCredentials(
    profile: ConnectionProfile,
    report: boolean,
  ): Promise<ProbeResult> {
    const password = profile.savePassword ? await this.store.getPassword(profile.id) : undefined;
    const requiresPassword = password === undefined && profile.savePassword;

    if (requiresPassword) {
      // The bridge will reject this, but prompting first avoids a pointless round trip and a
      // confusing "password authentication failed" for a password the user never entered.
      throw new ConnectionFailedError(
        profile.id,
        `A password is required for '${profile.name}'.`,
        true,
      );
    }

    return this.open(profile, password, report);
  }

  private toParams(profile: ConnectionProfile, password: string | undefined): ConnectionProfileParams {
    const poolSize = profile.poolSize
      ?? vscode.workspace.getConfiguration().get<number>(Config.poolSize, 1);

    const params: ConnectionProfileParams = {
      connectionId: profile.id,
      driverClassName: profile.driverClassName,
      url: profile.url,
      poolSize,
    };
    if (profile.user) {
      params.user = profile.user;
    }
    if (password !== undefined) {
      params.password = password;
    }
    if (profile.properties && Object.keys(profile.properties).length > 0) {
      params.properties = { ...profile.properties };
    }
    return params;
  }

  private setState(profileId: string, state: ConnectionState): void {
    const previous = this.states.get(profileId)?.status;
    if (previous === state.status && state.status !== 'error') {
      // Refresh the details without announcing a change the UI does not need to react to.
      this.states.set(profileId, state);
      return;
    }
    this.states.set(profileId, state);
    this.emitter.fire(profileId);
    void vscode.commands.executeCommand('setContext', ContextKeys.hasActiveConnection, this.connectedIds().length > 0);
  }

  private resetAll(): void {
    if (this.states.size === 0) {
      return;
    }
    log.debug('Clearing connection state because the bridge is no longer running');
    for (const [id, state] of this.states) {
      if (state.status !== 'disconnected') {
        this.states.set(id, { status: 'disconnected', lastError: state.lastError });
        this.emitter.fire(id);
      }
    }
    void vscode.commands.executeCommand('setContext', ContextKeys.hasActiveConnection, false);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.emitter.dispose();
  }
}
