import * as vscode from 'vscode';

import { Commands, Config } from '../constants';
import { splitStatements } from '../util/sqlStatementParser';

/**
 * Puts a Run action above every statement in a SQL file.
 *
 * Until now the only way to run a specific statement was to put the cursor in it, or to select it -
 * both of which require knowing that is how the command works. A lens above each statement makes the
 * unit of execution visible, which matters most in a file with several of them.
 *
 * A lens is only offered for documents the extension treats as SQL, and never for the read-only
 * documents it generates itself (column listings, DDL), where running anything would be meaningless.
 */
export class SqlCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses = this.emitter.event;

  /** Re-asks for lenses; used when the setting that enables them changes. */
  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration().get<boolean>(Config.codeLens, true)) {
      return [];
    }
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    for (const statement of splitStatements(document.getText())) {
      const start = document.positionAt(statement.start);
      const end = document.positionAt(statement.end);
      const range = new vscode.Range(start, end);

      // The range carries the statement, so the command never has to re-derive it from a cursor
      // position that may have moved between the lens being drawn and being clicked.
      lenses.push(
        new vscode.CodeLens(new vscode.Range(start, start), {
          command: Commands.runStatement,
          title: '$(play) Run',
          arguments: [range],
        }),
      );
    }
    return lenses;
  }
}
