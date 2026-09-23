import * as vscode from 'vscode';

import { Commands, Config, ContextKeys, VIEW_CONNECTIONS, VIEW_HISTORY } from './constants';
import { JdbcBridge } from './bridge/JdbcBridge';
import { Methods } from './bridge/protocol';
import { DriverManager } from './driver/DriverManager';
import { ConnectionStore } from './model/ConnectionStore';
import { ConnectionService } from './service/ConnectionService';
import { ConnectionTemplates } from './service/ConnectionTemplates';
import { ExportService } from './service/ExportService';
import { MetadataService } from './service/MetadataService';
import { QueryHistoryStore } from './service/QueryHistoryStore';
import { SqlEditorBinding } from './service/SqlEditorBinding';
import { DatabaseTreeProvider } from './tree/DatabaseTreeProvider';
import { HistoryTreeProvider } from './tree/HistoryTreeProvider';
import { HealthMonitor } from './health/HealthMonitor';
import { MetadataCache } from './sql/metadataCache';
import { SqlCompletionProvider } from './sql/completionProvider';
import { SqlCodeLensProvider } from './sql/codeLensProvider';
import { VariableService } from './service/VariableService';
import { VariablePanel } from './webview/VariablePanel';
import { VirtualDocumentProvider } from './util/VirtualDocuments';
import { JavaNotFoundError } from './bridge/JavaLocator';
import { registerConnectionCommands, setDriverContext } from './commands/connectionCommands';
import { registerQueryCommands } from './commands/queryCommands';
import type { CommandDependencies } from './commands/types';
import { describeError, log } from './util/logger';

/**
 * Held so `deactivate` can stop the bridge gracefully.
 *
 * The alternative - registering a disposer and hoping it runs - is not reliable: VS Code gives an
 * extension a short window on shutdown, and closing pooled connections properly needs the process to
 * be asked rather than killed.
 */
let bridgeForShutdown: JdbcBridge | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log.info('Open DB Client activating');

  const bridge = new JdbcBridge(context);
  bridgeForShutdown = bridge;

  const store = new ConnectionStore(context);
  const history = new QueryHistoryStore(context);
  const templates = await ConnectionTemplates.load(context);

  await Promise.all([store.load(), history.load()]);

  const connections = new ConnectionService(bridge, store);
  const metadata = new MetadataService(bridge);
  const drivers = new DriverManager(context, bridge);
  const exportService = new ExportService(bridge);
  const virtualDocuments = new VirtualDocumentProvider();
  const tree = new DatabaseTreeProvider(store, connections, metadata);
  const historyTree = new HistoryTreeProvider(history);
  const binding = new SqlEditorBinding(store);
  const health = new HealthMonitor(bridge, virtualDocuments);
  const metadataCache = new MetadataCache(metadata, connections);
  const completion = new SqlCompletionProvider(metadataCache, binding, connections);
  const codeLens = new SqlCodeLensProvider();
  const variables = new VariableService(context);

  // Completion is instant once the table list is cached, so it is fetched in the background as soon
  // as a connection comes up. On a database with thousands of tables that prefetch is slow enough to
  // be worth letting the user turn off, which is what the setting exists for.
  const prefetchSettings = vscode.workspace.getConfiguration();
  const onConnectionStateChanged = connections.onDidChangeState((profileId) => {
    if (connections.isConnected(profileId)) {
      if (prefetchSettings.get<boolean>(Config.intellisensePrefetchTables, true)) {
        void metadataCache.ensureTables(profileId);
      }
    } else {
      // A closed connection's schema may differ when it comes back, so nothing about it is retained.
      metadataCache.invalidate(profileId);
    }
  });

  const dependencies: CommandDependencies = {
    context,
    extensionUri: context.extensionUri,
    bridge,
    store,
    connections,
    metadata,
    drivers,
    exportService,
    templates,
    history,
    metadataCache,
    variables,
    tree,
    binding,
    virtualDocuments,
  };

  // Created as a TreeView rather than through registerTreeDataProvider so the provider can put the
  // active name filter in the view's description. Without it a filtered tree is indistinguishable
  // from a database that simply has few objects.
  const connectionsView = vscode.window.createTreeView(VIEW_CONNECTIONS, {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  tree.attachView(connectionsView);

  /**
   * Keeps the variable panel in step with the active script.
   *
   * It appears when the script has placeholders and closes when it does not, so it never lingers over
   * a file that has no variables. Values live in the service, so closing and reopening the panel -
   * or switching between two scripts that share a placeholder - loses nothing.
   */
  const syncVariables = (document: vscode.TextDocument | undefined): void => {
    variables.track(document);
    if (variables.activeCount > 0) {
      VariablePanel.show(variables);
    } else {
      VariablePanel.hide();
    }
  };

  let variableTracking: ReturnType<typeof setTimeout> | undefined;

  context.subscriptions.push(
    bridge,
    store,
    history,
    connections,
    drivers,
    tree,
    historyTree,
    binding,
    health,
    completion,
    codeLens,
    variables,
    onConnectionStateChanged,
    virtualDocuments,
    virtualDocuments.register(),

    connectionsView,

    vscode.window.registerTreeDataProvider(VIEW_HISTORY, historyTree),    vscode.commands.registerCommand(Commands.listDrivers, () => listDrivers(dependencies)),
    vscode.commands.registerCommand(Commands.restartBridge, () => restartBridge(dependencies)),
    vscode.commands.registerCommand(Commands.showHealth, () => health.showReport()),

    ...registerConnectionCommands(dependencies),
    ...registerQueryCommands(dependencies),

    // Registered once for the SQL language; the provider itself honours the enable setting.
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, codeLens),

    vscode.window.onDidChangeActiveTextEditor((editor) => syncVariables(editor?.document)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      // Typing a new placeholder should register it, but not on every keystroke: repainting the panel
      // mid-edit would fight the user for focus in the inputs.
      if (event.document !== vscode.window.activeTextEditor?.document) {
        return;
      }
      if (variableTracking !== undefined) {
        clearTimeout(variableTracking);
      }
      variableTracking = setTimeout(() => syncVariables(event.document), 400);
    }),
  );

  // A script may already be open when the extension activates.
  syncVariables(vscode.window.activeTextEditor?.document);

  // Drivers are loaded eagerly so the connection view can show its empty state correctly, and so a
  // missing Java installation is reported at startup rather than on the user's first query.
  await refreshDrivers(dependencies, { quiet: true });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(Config.driverPaths) ||
        event.affectsConfiguration(Config.driverClassNames)
      ) {
        void refreshDrivers(dependencies, { quiet: false });
      }
      if (event.affectsConfiguration(Config.resultMaxCacheBytes)) {
        void applyBridgeConfiguration(dependencies);
      }
      if (event.affectsConfiguration(Config.codeLens)) {
        codeLens.refresh();
      }
    }),

    vscode.commands.registerCommand(Commands.showVariables, () => {
      syncVariables(vscode.window.activeTextEditor?.document);
      VariablePanel.focus();
    }),

    // Result panels cannot survive the process that holds their rows.
    bridge.onDidChangeState((state) => {
      if (state === 'stopped' || state === 'failed') {
        ResultPanelBridgeHook.closePanels();
        void vscode.commands.executeCommand('setContext', ContextKeys.bridgeReady, false);
      } else if (state === 'ready') {
        void vscode.commands.executeCommand('setContext', ContextKeys.bridgeReady, true);
        void applyBridgeConfiguration(dependencies);
      }
    }),
  );

  log.info('Open DB Client activated');
}

export async function deactivate(): Promise<void> {
  // Asked rather than killed, so the bridge closes pooled connections on the way out. A database that
  // sees connections vanish instead can hold server-side resources until it notices.
  await bridgeForShutdown?.stop();
  bridgeForShutdown = undefined;
}

// ---------------------------------------------------------------------------
// drivers
// ---------------------------------------------------------------------------

/**
 * Loads the driver classpath into the bridge.
 *
 * @param quiet when true, a missing Java installation is logged but not shown: this runs during
 *              activation, and a modal dialog on startup for a user who has not yet tried to connect
 *              would be intrusive. The guidance is shown the moment they attempt to connect.
 */
async function refreshDrivers(
  dependencies: CommandDependencies,
  options: { quiet: boolean },
): Promise<void> {
  try {
    await dependencies.drivers.register();
  } catch (error) {
    if (error instanceof JavaNotFoundError) {
      log.warn(error.guidance);
      if (!options.quiet) {
        void vscode.window.showErrorMessage(error.guidance, { modal: true });
      }
    } else {
      log.error(error, 'Registering JDBC drivers failed');
      if (!options.quiet) {
        void vscode.window.showErrorMessage(`Could not load JDBC drivers: ${describeError(error)}`);
      }
    }
  } finally {
    await setDriverContext(dependencies);
    dependencies.tree.refresh();
  }
}

async function listDrivers(dependencies: CommandDependencies): Promise<void> {
  const drivers = dependencies.drivers.list();
  const failures = dependencies.drivers.listFailures();

  const items = [
    ...drivers.map((driver) => ({
      label: `$(check) ${driver.displayName}`,
      description: driver.driverClassName,
      detail: driver.sourceJar ? `From ${driver.sourceJar}` : 'Loaded by explicit class name',
    })),
    ...failures.map((failure) => ({
      label: `$(error) ${failure.driverClassName ?? failure.jar ?? 'unknown'}`,
      description: failure.driverClassName ?? '',
      detail: failure.message,
    })),
  ];

  if (items.length === 0) {
    const action = await vscode.window.showInformationMessage(
      'No JDBC drivers are loaded. Add a driver jar to connect to a database.',
      'Add Driver Jar…',
    );
    if (action === 'Add Driver Jar…') {
      await dependencies.drivers.addJars();
      await setDriverContext(dependencies);
    }
    return;
  }

  await vscode.window.showQuickPick(items, {
    title: `${drivers.length} driver(s) loaded`,
    placeHolder: failures.length > 0 ? `${failures.length} could not be loaded` : 'All loaded successfully',
  });
}

/**
 * Restarts the bridge.
 *
 * The only way to make a driver change fully take effect: a JVM cannot unload a class, so a jar that
 * has been replaced or removed keeps its old classes alive until the process is replaced.
 */
async function restartBridge(dependencies: CommandDependencies): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    'Restart the JDBC bridge? Every open connection will be closed and results will be discarded.',
    { modal: true },
    'Restart',
  );
  if (confirmed !== 'Restart') {
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Restarting the JDBC bridge' },
    async () => {
      try {
        await dependencies.bridge.restart();
        await refreshDrivers(dependencies, { quiet: false });
        void vscode.window.showInformationMessage('The JDBC bridge has been restarted.');
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not restart the bridge: ${describeError(error)}`);
      }
    },
  );
}

/** Pushes settings the bridge needs to know about. */
async function applyBridgeConfiguration(dependencies: CommandDependencies): Promise<void> {
  const maxCacheBytes = vscode.workspace.getConfiguration().get<number>(Config.resultMaxCacheBytes, 0);
  if (!maxCacheBytes || maxCacheBytes <= 0) {
    return;
  }
  try {
    await dependencies.bridge.request(Methods.systemConfigure, { resultMaxCacheBytes: maxCacheBytes });
    log.debug(`Result cache budget set to ${maxCacheBytes} bytes`);
  } catch (error) {
    log.debug(`Could not apply the result cache budget: ${describeError(error)}`);
  }
}

/**
 * Indirection that keeps `extension.ts` from importing the webview layer directly.
 *
 * The result panel imports VS Code webview APIs, and pulling that in at activation time for a
 * function that is only called on bridge failure is unnecessary; the dynamic import also keeps the
 * dependency one-directional.
 */
const ResultPanelBridgeHook = {
  closePanels(): void {
    void import('./webview/ResultPanel')
      .then((module) => module.ResultPanel.closeAll())
      .catch((error: unknown) => log.debug(`Closing result panels failed: ${describeError(error)}`));
  },
};
