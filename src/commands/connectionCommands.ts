import * as vscode from 'vscode';

import { Commands, ContextKeys } from '../constants';
import type { ConnectionProfile, ConnectionProfileDraft } from '../model/ConnectionProfile';
import { emptyProfile, profileLabel } from '../model/ConnectionProfile';
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
 * Collects the details of a connection through a sequence of input boxes.
 *
 * Chosen over a webview form deliberately. It is far less code, it works in the command palette and
 * over a remote connection, and every field benefits from the standard input box behaviours users
 * already know. The unavoidable cost is that driver properties have to be typed as `key=value` pairs
 * rather than edited in a table, which is a reasonable trade for an advanced setting.
 */
async function promptForProfile(
  dependencies: CommandDependencies,
  existing?: ConnectionProfile,
): Promise<{ draft: ConnectionProfileDraft; password?: string } | undefined> {
  const driverClassName = await chooseDriver(dependencies, existing);
  if (!driverClassName) {
    return undefined;
  }

  const suggestedUrl = dependencies.templates.urlFor(driverClassName);
  const url = await vscode.window.showInputBox({
    title: 'JDBC URL',
    prompt: suggestedUrl
      ? `For example: ${suggestedUrl}`
      : 'The full JDBC URL, passed to the driver unchanged',
    value: existing?.url ?? suggestedUrl ?? '',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return 'A JDBC URL is required';
      }
      return trimmed.toLowerCase().startsWith('jdbc:') ? undefined : "A JDBC URL starts with 'jdbc:'";
    },
  });
  if (url === undefined) {
    return undefined;
  }

  const name = await vscode.window.showInputBox({
    title: 'Name',
    prompt: 'A label for this connection',
    value: existing?.name ?? url.trim(),
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'A name is required'),
  });
  if (name === undefined) {
    return undefined;
  }

  const user = await vscode.window.showInputBox({
    title: 'User',
    prompt: 'Leave empty when the URL already carries the credentials',
    value: existing?.user ?? '',
    ignoreFocusOut: true,
  });
  if (user === undefined) {
    return undefined;
  }

  const password = await vscode.window.showInputBox({
    title: existing ? 'Password (leave empty to keep the saved one)' : 'Password',
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) {
    return undefined;
  }

  const propertyText = await vscode.window.showInputBox({
    title: 'Driver properties',
    prompt: 'Extra JDBC properties as key=value, separated by semicolons. Leave empty for none.',
    value: formatProperties(existing?.properties),
    ignoreFocusOut: true,
    validateInput: validateProperties,
  });
  if (propertyText === undefined) {
    return undefined;
  }

  return {
    draft: {
      ...emptyProfile(),
      id: existing?.id,
      name: name.trim(),
      driverClassName,
      url: url.trim(),
      user: user.trim() || undefined,
      properties: parseProperties(propertyText),
      savePassword: true,
      poolSize: existing?.poolSize,
      color: existing?.color,
    },
    password: password.length > 0 ? password : undefined,
  };
}

async function chooseDriver(
  dependencies: CommandDependencies,
  existing?: ConnectionProfile,
): Promise<string | undefined> {
  if (existing?.driverClassName) {
    return existing.driverClassName;
  }

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

  // One driver needs no prompt; several do, and the search across description and detail means a user
  // can find theirs by class name or by the jar it came from.
  if (drivers.length === 1) {
    return drivers[0].driverClassName;
  }

  const picked = await vscode.window.showQuickPick(
    drivers.map((driver) => ({
      label: driver.displayName,
      description: driver.driverClassName,
      detail: driver.sourceJar,
      driver,
    })),
    { title: 'Driver', placeHolder: 'Which JDBC driver?', matchOnDescription: true, matchOnDetail: true },
  );
  return picked?.driver.driverClassName;
}

function formatProperties(properties: Readonly<Record<string, string>> | undefined): string {
  return properties
    ? Object.entries(properties)
        .map(([key, value]) => `${key}=${value}`)
        .join(';')
    : '';
}

function parseProperties(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of text.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator > 0) {
      result[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    }
  }
  return result;
}

function validateProperties(value: string): string | undefined {
  for (const entry of value.split(';')) {
    const trimmed = entry.trim();
    if (trimmed && !trimmed.includes('=')) {
      return `'${trimmed}' is not key=value`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function addConnection(dependencies: CommandDependencies): Promise<void> {
  const prompted = await promptForProfile(dependencies);
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
  const prompted = await promptForProfile(dependencies, node.profile);
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
