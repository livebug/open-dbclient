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
import { VariablesView } from './webview/VariablesView';
import { VirtualDocumentProvider } from './util/VirtualDocuments';
import { JavaNotFoundError } from './bridge/JavaLocator';
import { registerConnectionCommands, setDriverContext } from './commands/connectionCommands';
import { registerQueryCommands } from './commands/queryCommands';
import type { CommandDependencies } from './commands/types';
import { describeError, log } from './util/logger';
import { currentLocale, setLocale, t } from './util/i18n';

/**
 * Held so `deactivate` can stop the bridge gracefully.
 *
 * The alternative - registering a disposer and hoping it runs - is not reliable: VS Code gives an
 * extension a short window on shutdown, and closing pooled connections properly needs the process to
 * be asked rather than killed.
 */
let bridgeForShutdown: JdbcBridge | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Before anything else: every message below is written through the catalog, and the first ones are
  // emitted while the services are still being constructed.
  setLocale(vscode.env.language);
  log.info(`Open DB Client activating (${currentLocale()})`);

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
  const variablesView = new VariablesView(context.extensionUri, variables);

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
   * Keeps the variables view in step with the active script.
   *
   * Only the service is updated; the view is never opened or closed by the extension. It is a tab in
   * the bottom panel, so it costs nothing while unused - whereas the old panel opened itself beside
   * the editor whenever a script had a placeholder and closed itself again when one was deleted, which
   * is the behaviour that read as flickering.
   */
  const syncVariables = (document: vscode.TextDocument | undefined): void => {
    variables.track(document);
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
    variablesView,
    onConnectionStateChanged,
    virtualDocuments,
    virtualDocuments.register(),

    connectionsView,

    vscode.window.registerTreeDataProvider(VIEW_HISTORY, historyTree),
    vscode.window.registerWebviewViewProvider(VariablesView.viewType, variablesView),
    vscode.commands.registerCommand(Commands.listDrivers, () => listDrivers(dependencies)),
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
      if (
        event.affectsConfiguration(Config.metadataQueries) ||
        event.affectsConfiguration(Config.metadataTimeoutSeconds)
      ) {
        // The rules decide what the tree and the completion cache are given, so a change to them has to
        // reach both - otherwise the setting appears to do nothing until the window is reloaded.
        metadataCache.invalidate();
        tree.refresh();
      }
    }),

    vscode.commands.registerCommand(Commands.showVariables, () => {
      syncVariables(vscode.window.activeTextEditor?.document);
      void VariablesView.reveal();
    }),

    // The manual counterpart to the automatic tracking: a script whose placeholders never registered - or
    // a view opened before the tracking ran - can be asked to read them again.
    vscode.commands.registerCommand(Commands.refreshVariables, () => {
      syncVariables(vscode.window.activeTextEditor?.document);
      variablesView.rescan();
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
        void vscode.window.showErrorMessage(t('Could not load JDBC drivers: {0}', describeError(error)));
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
      detail: driver.sourceJar ? t('From {0}', driver.sourceJar) : t('Loaded by explicit class name'),
    })),
    ...failures.map((failure) => ({
      label: `$(error) ${failure.driverClassName ?? failure.jar ?? t('unknown')}`,
      description: failure.driverClassName ?? '',
      detail: failure.message,
    })),
  ];

  if (items.length === 0) {
    const action = await vscode.window.showInformationMessage(
      t('No JDBC drivers are loaded. Add a driver jar to connect to a database.'),
      t('Add Driver Jar…'),
    );
    if (action === t('Add Driver Jar…')) {
      await dependencies.drivers.addJars();
      await setDriverContext(dependencies);
    }
    return;
  }

  await vscode.window.showQuickPick(items, {
    title: t('{0} driver(s) loaded', drivers.length),
    placeHolder:
      failures.length > 0
        ? t('{0} could not be loaded', failures.length)
        : t('All loaded successfully'),
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
    t('Restart the JDBC bridge? Every open connection will be closed and results will be discarded.'),
    { modal: true },
    t('Restart'),
  );
  if (confirmed !== t('Restart')) {
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('Restarting the JDBC bridge') },
    async () => {
      try {
        await dependencies.bridge.restart();
        await refreshDrivers(dependencies, { quiet: false });
        void vscode.window.showInformationMessage(t('The JDBC bridge has been restarted.'));
      } catch (error) {
        void vscode.window.showErrorMessage(
          t('Could not restart the bridge: {0}', describeError(error)),
        );
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
