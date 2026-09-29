import * as vscode from 'vscode';

import type { VariableService } from '../service/VariableService';
import { currentLocale, t } from '../util/i18n';

/** One row of the view, as the webview renders it. */
interface VariableRow {
  readonly name: string;
  readonly value: string;
}

/**
 * The `${NAME}` placeholders of the active script, as a tab in the bottom panel.
 *
 * <h2>Why a view and not a webview panel</h2>
 *
 * It used to be a webview panel beside the editor, which meant the SQL being edited lost a column to
 * it for as long as the file was open. Placeholders are filled in once and then left alone, so what
 * they need is a place that costs nothing while unused - which is exactly what a tab next to Terminal
 * is. It is also where a user looks for "the script's parameters", next to the output of the script
 * they just ran.
 *
 * <h2>Why nothing is repainted wholesale</h2>
 *
 * The panel used to be rebuilt by assigning `webview.html` on every change. Assigning that property
 * reloads the document: the inputs were recreated from scratch, focus and caret were lost, and the
 * visible result was a panel that flickered on every keystroke - the flicker was the document
 * reloading. Here the document is written once and only the values that actually changed are sent
 * afterwards, and the webview ignores values for the input it is typing into.
 */
export class VariablesView implements vscode.WebviewViewProvider, vscode.Disposable {
  /** Matches the view contributed in `package.json`; the two must agree or nothing is rendered. */
  static readonly viewType = 'open-dbclient.variables';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: VariableService,
  ) {
    this.disposables.push(this.service.onDidChange(() => this.push()));
  }

  /**
   * Brings the view's tab forward.
   *
   * The tab is never closed behind the user's back: it is a contributed view, and a view that appears
   * and disappears on its own is worse than one that is simply always there. Revealing it is therefore
   * the only action available, and it happens when there is something to act on - the command, or a run
   * that was refused because a value was missing.
   */
  static async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${VariablesView.viewType}.focus`);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);

    this.disposables.push(
      view.webview.onDidReceiveMessage((message: { type?: string; name?: string; value?: string }) => {
        if (message.type === 'change' && typeof message.name === 'string') {
          void this.service.setValue(message.name, message.value ?? '');
        }
        if (message.type === 'ready') {
          // The state pushed when the view resolved is usually sent before the webview's script has
          // started, so it is lost. This is the one that is actually seen.
          this.push();
        }
      }),
      view.onDidDispose(() => {
        this.view = undefined;
      }),
    );

    this.push();
  }

  /** Sends the current placeholders and values; called on every change the service reports. */
  private push(): void {
    if (!this.view) {
      return;
    }
    const rows: VariableRow[] = this.service.activeNames.map((name) => ({
      name,
      value: this.service.value(name),
    }));
    void this.view.webview.postMessage({ type: 'state', rows, locale: currentLocale() });
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.view = undefined;
  }

  /**
   * The document is static by design: everything that changes arrives as a message.
   *
   * Values are never interpolated into this HTML. The webview builds the rows itself and assigns
   * `value`/`textContent`, so a placeholder name or a value containing markup cannot become markup -
   * which also removes the escaping the old string-building version had to get right.
   */
  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'variables', 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'variables', 'style.css'),
    );
    const nonce = createNonce();

    const contentSecurityPolicy = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="${currentLocale()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>${t('SQL Script Variables')}</title>
</head>
<body>
  <p class="hint" id="hint"></p>
  <div id="rows"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** A fresh nonce for the content security policy. */
function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
