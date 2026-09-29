import * as vscode from 'vscode';

import { Commands, Config, VIRTUAL_DOCUMENT_SCHEME } from '../constants';
import { isSqlDocument } from '../service/SqlEditorBinding';
import { splitStatements } from '../util/sqlStatementParser';
import { t } from '../util/i18n';

/**
 * Puts a Run action above every statement in a SQL file.
 *
 * Until now the only way to run a specific statement was to put the cursor in it, or to select it -
 * both of which require knowing that is how the command works. A lens above each statement makes the
 * unit of execution visible, which matters most in a file with several of them.
 *
 * <h2>Why the check is not `uri.scheme === 'file'`</h2>
 *
 * It used to be, and that is why the Run button vanished the moment a query was saved: an untitled
 * document has the `untitled` scheme, so the button was there while the query was being written and
 * gone as soon as it had a name. Anywhere the extension host is remote - SSH, WSL, a container, which
 * is where this was reported - a saved file's scheme is `vscode-remote`, and `file` therefore never
 * matched. The document's own intent decides instead, which is what `isSqlDocument` encodes.
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
    // The one scheme that is excluded: the read-only documents the extension generates itself (column
    // listings, DDL), where running anything would be meaningless.
    if (document.uri.scheme === VIRTUAL_DOCUMENT_SCHEME) {
      return [];
    }
    if (!isSqlDocument(document)) {
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
          title: `$(play) ${t('Run')}`,
          arguments: [range],
        }),
      );
    }
    return lenses;
  }
}
