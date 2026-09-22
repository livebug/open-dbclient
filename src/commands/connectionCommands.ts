import * as vscode from 'vscode';

import { Commands, ContextKeys } from '../constants';
import type { ConnectionProfile, ConnectionProfileDraft } from '../model/ConnectionProfile';
import { profileLabel } from '../model/ConnectionProfile';
import { ConnectionFormPanel, valuesFor } from '../webview/ConnectionFormPanel';
import type { DatabaseTreeNode } from '../tree/nodeTypes';
import { describeError, log } from '../util/logger';
import type { CommandDependencies } from './types';

/** Commands for creating, editing and connecting saved profiles. */
export function registerConnectionCommands(dependencies: CommandDependencies): vscode.Disposable[] {
  const register = (command: string, handler: (...args: unknown[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(command, handler);

  return [
    register(Commands.addConnection, () => addConnection(dependencies)),
    register(Commands.editConnection, (node) => editConnection(dependencies, asNode(node))),
    register(Commands.duplicateConnection, (node) => duplicateConnection(dependencies, asNode(node))),
    register(Commands.deleteConnection, (node) => deleteConnection(dependencies, asNode(node))),
    register(Commands.testConnection, (node) => testConnection(dependencies, asNode(node))),
    register(Commands.connect, (node) => connect(dependencies, asNode(node))),
    register(Commands.disconnect, (node) => disconnect(dependencies, asNode(node))),
    register(Commands.selectConnection, () => selectConnectionForActiveEditor(dependencies)),
    register(Commands.copyName, (node) => copyName(asNode(node))),
    register(Commands.filterTree, () => filterTree(dependencies)),
    register(Commands.clearFilter, () => dependencies.tree.setFilter('')),
  ];
}

/** Keeps the `hasDrivers` context key in step, so the empty state can be shown in the view. */
export async function setDriverContext(dependencies: CommandDependencies): Promise<void> {
  await vscode.commands.executeCommand(
    'setContext',
    ContextKeys.hasDrivers,
    dependencies.drivers.hasDrivers,
  );
}

function asNode(value: unknown): DatabaseTreeNode | undefined {
  return typeof value === 'object' && value !== null && 'kind' in value
    ? (value as DatabaseTreeNode)
    : undefined;
}

// ---------------------------------------------------------------------------
// connection form
// ---------------------------------------------------------------------------

/**
 * Opens the connection form and returns what the user confirmed.
 *
 * A webview form rather than a chain of input boxes, because testing a connection is only meaningful
 * once the URL, credentials and properties are all present and there is no way to hold all of that at
 * once across modal prompts. See ConnectionFormPanel for the rest of the reasoning.
 */
async function openConnectionForm(
  dependencies: CommandDependencies,
  existing?: ConnectionProfile,
): Promise<{ draft: ConnectionProfileDraft; password?: string } | undefined> {
  const drivers = dependencies.drivers.list();
  if (drivers.length === 0) {
    const action = await vscode.window.showWarningMessage(
      'No JDBC driver is loaded. A driver jar is needed before a connection can be created.',
      'Add Driver Jar…',
      'Open Driver Folder',
    );
    if (action === 'Add Driver Jar…') {
      await dependencies.drivers.addJars();
      await setDriverContext(dependencies);
    } else if (action === 'Open Driver Folder') {
      await dependencies.drivers.openFolder();
    }
    return undefined;
  }

  const storedPassword = existing ? await dependencies.store.getPassword(existing.id) : undefined;

  const result = await ConnectionFormPanel.show({
    extensionUri: dependencies.extensionUri,
    mode: existing ? 'edit' : 'add',
    values: existing
      ? valuesFor(existing)
      : {
          name: '',
          driverClassName: drivers[0].driverClassName,
          url: dependencies.templates.urlFor(drivers[0].driverClassName) ?? '',
          user: '',
          password: '',
          properties: '',
          poolSize: '',
        },
    hasStoredPassword: storedPassword !== undefined,
    drivers: drivers.map((driver) => ({
      className: driver.driverClassName,
      label: driver.displayName,
      detail: driver.sourceJar,
    })),
    // The bridge's test entry point opens and closes without registering a pool, so an id here has no
    // effect on a connection that is already live.
    connect: (draft, password) =>
      dependencies.connections.test({ ...draft, id: existing?.id ?? 'form' }, password),
    suggestUrl: (values) => dependencies.templates.urlFor(values.driverClassName),
  });

  if (!result) {
    return undefined;
  }
  return {
    draft: { ...result.draft, id: existing?.id },
    password: result.password,
  };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function addConnection(dependencies: CommandDependencies): Promise<void> {
  const prompted = await openConnectionForm(dependencies);
  if (!prompted) {
    return;
  }

  const profile = await dependencies.store.add(prompted.draft);
  if (prompted.password !== undefined) {
    await dependencies.store.setPassword(profile.id, prompted.password);
  }
  dependencies.tree.refresh();

  const chosen = await vscode.window.showInformationMessage(
    `Saved connection '${profileLabel(profile)}'.`,
    'Connect',
  );
  if (chosen === 'Connect') {
    await runConnect(dependencies, profile);
  }
}

async function editConnection(
  dependencies: CommandDependencies,
  node: DatabaseTreeNode | undefined,
): Promise<void> {
  if (node?.kind !== 'connection') {
    return;
  }
  const prompted = await openConnectionForm(dependencies, node.profile);
  if (!prompted) {
    return;
  }

  await dependencies.store.update({ ...prompted.draft, id: node.profile.id });
  if (prompted.password !== undefined) {
    await dependencies.store.setPassword(node.profile.id, prompted.password);
  }

  // URL, credentials and properties all affect the live session, so the existing connection is
  // dropped rather than left running with settings the user has just changed.
  await dependencies.connections.disconnect(node.profile.id);
  dependencies.tree.refresh();
}

async function duplicateConnection(
  dependencies: CommandDependencies,
  node: DatabaseTreeNode | undefined,
): Promise<void> {
  if (node?.kind !== 'connection') {
    return;
  }

  const copy = await dependencies.store.add({
    name: `${node.profile.name} copy`,
    driverClassName: node.profile.driverClassName,
    url: node.profile.url,
    user: node.profile.user,
    properties: node.profile.properties,
    poolSize: node.profile.poolSize,
    savePassword: node.profile.savePassword,
    color: node.profile.color,
  });

  const password = await dependencies.store.getPassword(node.profile.id);
  if (password !== undefined) {
    await dependencies.store.setPassword(copy.id, password);
  }
  dependencies.tree.refresh();
}

async function deleteConnection(
  dependencies: CommandDependencies,
  node: DatabaseTreeNode | undefined,
): Promise<void> {
  if (node?.kind !== 'connection') {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Delete the saved connection '${profileLabel(node.profile)}'? The database itself is not affected.`,
    { modal: true },
    'Delete',
  );
  if (confirmed !== 'Delete') {
    return;
  }

  await dependencies.connections.disconnect(node.profile.id);
  await dependencies.store.remove(node.profile.id);
  dependencies.tree.refresh();
}

async function testConnection(
  dependencies: CommandDependencies,
  node: DatabaseTreeNode | undefined,
): Promise<void> {
  if (node?.kind !== 'connection') {
    return;
  }

  const password = node.profile.savePassword
    ? await dependencies.store.getPassword(node.profile.id)
    : undefined;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Connecting to ${profileLabel(node.profile)}`,
    },
    async () => {
      try {
        const result = await dependencies.connections.test(node.profile, password);
        void vscode.window.showInformationMessage(
          `Connected in ${result.connectMillis} ms. ${result.capabilities.description}`,
        );
      } catch (error) {
        void vscode.window.showErrorMessage(`Connection failed: ${describeError(error)}`);
      }
    },
  );
}

async function connect(
  dependencies: CommandDependencies,
  node: DatabaseTreeNode | undefined,
): Promise<void> {
  if (node?.kind !== 'connection') {
    return;
  }
  await runConnect(dependencies, node.profile);
  dependencies.tree.refreshNode(node);
}

async function runConnect(
  dependencies: CommandDependencies,
  profile: ConnectionProfile,
): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Connecting to ${profileLabel(profile)}` },
    async () => {
      try {
        const result = await dependencies.connections.connect(profile);
        void vscode.window.showInformationMessage(
          `Connected to ${result.capabilities.description} in ${result.connectMillis} ms.`,
        );
      } catch {
        // connections.connect already reported the failure to the user.
        log.debug(`Connect to '${profileLabel(profile)}' did not succeed`);
      }
    },
  );
}

async function disconnect(
  dependencies: CommandDependencies,
  node: DatabaseTreeNode | undefined,
): Promise<void> {
  if (node?.kind !== 'connection') {
    return;
  }
  await dependencies.connections.disconnect(node.profile.id);
  dependencies.tree.refreshNode(node);
}

/**
 * Attaches the active SQL file to a connection.
 *
 * Reached from the status bar, which is where a user looks when they realise a statement is about to
 * run somewhere unexpected.
 */
async function selectConnectionForActiveEditor(dependencies: CommandDependencies): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'sql') {
    void vscode.window.showInformationMessage('Open a SQL file first.');
    return;
  }

  const options = dependencies.store.list().map((profile) => ({
    label: profileLabel(profile),
    description: profile.url,
    profile,
  }));
  if (options.length === 0) {
    void vscode.window.showInformationMessage('No saved connections yet.');
    return;
  }

  const picked = await vscode.window.showQuickPick(options, {
    title: 'Attach this file to a connection',
    placeHolder: 'The choice is written into the file as a comment',
  });
  if (picked) {
    await dependencies.binding.bind(editor.document, picked.profile);
  }
}

async function copyName(node: DatabaseTreeNode | undefined): Promise<void> {
  if (!node) {
    return;
  }
  await vscode.env.clipboard.writeText(labelOf(node));
}

/**
 * Asks for a name filter and applies it.
 *
 * Pre-filled with the active filter so the command doubles as "edit the filter" instead of forcing a
 * clear-then-type cycle whenever a character was wrong. Submitting an empty box clears it, which
 * keeps the two commands consistent.
 */
async function filterTree(dependencies: CommandDependencies): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: 'Filter tables, views and columns',
    prompt: 'Show only names containing this text. Leave empty to clear.',
    value: dependencies.tree.activeFilter,
    placeHolder: 'e.g. order',
  });
  if (value === undefined) {
    return;
  }
  dependencies.tree.setFilter(value);
}

function labelOf(node: DatabaseTreeNode): string {
  switch (node.kind) {
    case 'connection':
      return profileLabel(node.profile);
    case 'catalog':
      return node.catalog;
    case 'schema':
      return node.schema;
    case 'table':
    case 'view':
      return node.table.name;
    case 'column':
      return node.column.name;
    case 'index':
      return node.index.name;
    case 'folder':
      return node.folder;
    default:
      return '';
  }
}
