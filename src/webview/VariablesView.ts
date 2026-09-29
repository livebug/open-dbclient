import * as vscode from 'vscode';

import { Commands } from '../constants';
import type { VariableService } from '../service/VariableService';
import { currentLocale, t } from '../util/i18n';
import { describeError, log } from '../util/logger';

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

  /** The instance behind the visible view, so `reveal` can use the view API rather than a command id. */
  private static current: VariablesView | undefined;

  private view: vscode.WebviewView | undefined;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: VariableService,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    // The same command the palette runs, so a click and the palette entry cannot drift apart.
    this.statusBar.command = Commands.showVariables;

    this.disposables.push(
      this.statusBar,
      this.service.onDidChange(() => this.push()),
    );
    this.updateStatusBar();
  }

  /**
   * Brings the view's tab forward.
   *
   * Two mechanisms, because neither covers every state. The view's own `show()` exists only once VS Code
   * has resolved the provider, which happens when the view first becomes visible - so a view that has
   * never been opened has no object to show. The generated `<viewId>.focus` command covers exactly that
   * case. Both are attempted, and which one was used is logged: a view that cannot be brought forward at
   * all is otherwise indistinguishable from one that opened and rendered empty.
   */
  static async reveal(): Promise<void> {
    const current = VariablesView.current;
    if (current?.view) {
      current.view.show(false);
      log.debug('Revealed the variables view through WebviewView.show');
      return;
    }

    try {
      await vscode.commands.executeCommand(`${VariablesView.viewType}.focus`);
      log.debug('Revealed the variables view through its generated focus command');
    } catch (error) {
      log.warn(`Could not reveal the variables view: ${describeError(error)}`);
    }
  }

  /**
   * Re-reads the placeholders of the active script.
   *
   * The manual counterpart to the automatic tracking. Tracking runs while a document changes and when the
   * active editor changes, so a view that was opened before either happened would show nothing and there
   * was no way for the user to ask again.
   */
  rescan(): void {
    this.service.track(vscode.window.activeTextEditor?.document);
    this.push();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    VariablesView.current = this;
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
          // started, so it is lost. This is the one that is actually seen - and it is also the only
          // evidence that the script ran at all, which is why it is logged.
          log.debug('The variables view is ready');
          this.push();
        }
      }),
      view.onDidDispose(() => {
        this.view = undefined;
        if (VariablesView.current === this) {
          VariablesView.current = undefined;
        }
      }),
    );

    this.push();
  }

  /** Sends the current placeholders and values; called on every change the service reports. */
  private push(): void {
    const rows: VariableRow[] = this.service.activeNames.map((name) => ({
      name,
      value: this.service.value(name),
    }));

    // The tab carries the count as well as the editor status bar: the view is one click away and the count
    // is what says whether there is anything in it.
    if (this.view) {
      this.view.description = rows.length > 0 ? t('{0} placeholder(s)', rows.length) : undefined;
      this.view.badge = rows.length > 0
        ? { value: rows.length, tooltip: t('{0} placeholder(s)', rows.length) }
        : undefined;
      void this.view.webview.postMessage({ type: 'state', rows, locale: currentLocale() });
    }

    this.updateStatusBar(rows.length);
  }

  /**
   * Reflects the placeholder count in the status bar.
   *
   * Shown only while the active script has placeholders, so it costs nothing in the many windows where no
   * script is open. This exists because the view is a tab in a panel that may well be collapsed: without
   * something outside the panel, "variables are available" has no sign at all until the panel is opened.
   */
  private updateStatusBar(count = this.service.activeCount): void {
    if (count === 0) {
      this.statusBar.hide();
      return;
    }
    const names = this.service.activeNames.map((name) => `\${${name}}`).join(', ');
    this.statusBar.text = `$(symbol-parameter) ${t('{0} variable(s)', count)}`;
    this.statusBar.tooltip = new vscode.MarkdownString(
      `${t('Script variables')}: ${names}\n\n${t('Click to edit their values.')}`,
    );
    this.statusBar.show();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.view = undefined;
    if (VariablesView.current === this) {
      VariablesView.current = undefined;
    }
  }

  /**
   * The document is static by design: everything that changes arrives as a message.
   *
   * Values are never interpolated into this HTML. The webview builds the rows itself and assigns
   * `value`/`textContent`, so a placeholder name or a value containing markup cannot become markup -
   * which also removes the escaping the old string-building version had to get right.
   *
   * The hint text is written here as well as by the script, so a script that fails to load leaves a view
   * that explains itself rather than a blank rectangle nobody can diagnose.
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
  <p class="hint" id="hint">${t('Values are substituted before the statement runs. A placeholder with no value stops the run.')}</p>
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
