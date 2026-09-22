import * as vscode from 'vscode';

import { CONNECTION_DIRECTIVE, ContextKeys, connectionDirective } from '../constants';
import { profileLabel, type ConnectionProfile } from '../model/ConnectionProfile';
import type { ConnectionStore } from '../model/ConnectionStore';
import { log } from '../util/logger';

/**
 * Whether a document should be treated as a SQL script.
 *
 * Language alone is not enough: `New Query` opens an untitled document, and saving it under a name
 * the editor does not map to SQL silently changes its language, which used to take the run command
 * and the completion provider with it. The directive is the durable signal.
 */
export function isSqlDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'sql' || CONNECTION_DIRECTIVE.test(document.getText());
}

/**
 * Attaches SQL files to connections.
 *
 * The binding is a `-- @connection: name` directive inside the file rather than editor state. That
 * choice costs a visible line of SQL and buys three things: the binding survives a window reload
 * without any state bookkeeping, it travels with the file when it is shared or committed, and the
 * user can see and edit it instead of wondering why a query went to the wrong database.
 */
export class SqlEditorBinding implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: ConnectionStore) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = 'open-dbclient.selectConnection';

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusBar()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
          this.updateStatusBar();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => void this.keepSqlLanguage(document)),
      this.store.onDidChange(() => this.updateStatusBar()),
      this.statusBar,
    );

    this.updateStatusBar();
  }

  /**
   * Puts the language back to SQL after a save that changed it.
   *
   * Only when it landed on plain text: anything else was a deliberate choice of the user's, and
   * overriding it would be rude. Without this the file keeps opening as plain text, so syntax
   * colouring and completion stay off for a file that is plainly a SQL script.
   */
  private async keepSqlLanguage(document: vscode.TextDocument): Promise<void> {
    if (document.languageId !== 'plaintext') {
      return;
    }
    if (!CONNECTION_DIRECTIVE.test(document.getText())) {
      return;
    }

    try {
      await vscode.languages.setTextDocumentLanguage(document, 'sql');
      log.debug(`Restored the SQL language for ${document.uri.fsPath || document.uri.path}`);
    } catch (error) {
      log.debug(`Could not restore the SQL language: ${String(error)}`);
    }
  }

  /** The profile a document is bound to, or undefined when it has no usable directive. */
  resolve(document: vscode.TextDocument): ConnectionProfile | undefined {
    if (!isSqlDocument(document)) {
      return undefined;
    }
    const match = CONNECTION_DIRECTIVE.exec(document.getText());
    if (!match) {
      return undefined;
    }
    return this.store.findByName(match[1]);
  }

  /** The name written in the directive, whether or not it resolves to a saved profile. */
  directiveText(document: vscode.TextDocument): string | undefined {
    return CONNECTION_DIRECTIVE.exec(document.getText())?.[1];
  }

  /** Writes the directive, replacing an existing one in place. */
  async bind(document: vscode.TextDocument, profile: ConnectionProfile): Promise<void> {
    const directive = connectionDirective(profile.name);
    const text = document.getText();
    const match = CONNECTION_DIRECTIVE.exec(text);
    const edit = new vscode.WorkspaceEdit();

    if (match && match.index !== undefined) {
      const range = new vscode.Range(
        document.positionAt(match.index),
        document.positionAt(match.index + match[0].length),
      );
      edit.replace(document.uri, range, directive);
    } else {
      edit.insert(document.uri, new vscode.Position(0, 0), `${directive}\n`);
    }

    await vscode.workspace.applyEdit(edit);
    log.debug(`Bound ${document.uri.fsPath.split(/[\\/]/).pop()} to '${profileLabel(profile)}'`);
    this.updateStatusBar();
  }

  /**
   * Reflects the active editor's binding in the status bar.
   *
   * Showing it only for SQL files keeps the status bar from carrying a permanently useless entry in
   * the many windows where no SQL is open at all.
   */
  updateStatusBar(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): void {
    if (!editor || !isSqlDocument(editor.document)) {
      void vscode.commands.executeCommand('setContext', ContextKeys.sqlFile, false);
      this.statusBar.hide();
      return;
    }

    void vscode.commands.executeCommand('setContext', ContextKeys.sqlFile, true);

    const profile = this.resolve(editor.document);
    if (profile) {
      this.statusBar.text = `$(database) ${profileLabel(profile)}`;
      this.statusBar.tooltip = new vscode.MarkdownString(
        `Queries run against **${profileLabel(profile)}**\n\n` +
          `\`${profile.driverClassName}\`\n\n${profile.url}\n\nClick to change.`,
      );
      this.statusBar.show();
      return;
    }

    const directive = this.directiveText(editor.document);
    this.statusBar.text = '$(database) No connection';
    this.statusBar.tooltip = directive
      ? `The directive names '${directive}', which is not a saved connection.`
      : 'Click to attach this file to a connection.';
    this.statusBar.show();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
