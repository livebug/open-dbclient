import * as vscode from 'vscode';

import type { VariableService } from '../service/VariableService';

/**
 * A strip of inputs, one per `${NAME}` placeholder in the active script.
 *
 * It sits in its own webview rather than in a tree view because the values are free text that the user
 * types, and tree items cannot be edited in place. It opens below the SQL by default, next to the
 * result panel, so the script stays visible while the values are filled in.
 */
export class VariablePanel implements vscode.Disposable {
  private static current: VariablePanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  /**
   * Opens the panel, or refreshes and reveals the one already open.
   *
   * Never takes focus. The panel opens by itself when a script with placeholders is opened, and
   * stealing the cursor out of the editor at that moment would make opening such a file unpleasant.
   * `focus()` is the explicit opt-in, used by the command.
   */
  static show(service: VariableService): VariablePanel {
    if (VariablePanel.current && !VariablePanel.current.disposed) {
      VariablePanel.current.render();
      VariablePanel.current.panel.reveal(undefined, true);
      return VariablePanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      'open-dbclient.variables',
      'Query Variables',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const instance = new VariablePanel(panel, service);
    VariablePanel.current = instance;
    return instance;
  }

  /** Reveals the panel and moves focus into it. */
  static focus(): void {
    VariablePanel.current?.panel.reveal(undefined, false);
  }

  /** Closes the panel, if it is open. */
  static hide(): void {
    VariablePanel.current?.panel.dispose();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly service: VariableService,
  ) {
    this.panel.iconPath = new vscode.ThemeIcon('symbol-parameter');

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: { type?: string; name?: string; value?: string }) => {
        if (message.type === 'change' && typeof message.name === 'string') {
          void this.service.setValue(message.name, message.value ?? '');
        }
      }),
      this.service.onDidChange(() => this.render()),
      this.panel.onDidDispose(() => this.dispose()),
    );

    this.render();
  }

  private render(): void {
    if (this.disposed) {
      return;
    }
    this.panel.title = `Query Variables (${this.service.activeCount})`;
    this.panel.webview.html = this.html();
  }

  private html(): string {
    const nonce = createNonce();
    const rows = this.service.activeNames
      .map((name) => {
        // Values are interpolated into an attribute, so escaping is not optional.
        const value = escapeAttribute(this.service.value(name));
        return `<label class="row">
      <span class="name">\${${escapeText(name)}}</span>
      <input type="text" data-name="${escapeAttribute(name)}" value="${value}" spellcheck="false" placeholder="value">
    </label>`;
      })
      .join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 12px; color: var(--vscode-foreground); }
  p.hint { color: var(--vscode-descriptionForeground); margin: 0 0 12px; }
  .row { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 8px; align-items: center; margin-bottom: 8px; }
  .name { font-family: var(--vscode-editor-font-family); white-space: nowrap; }
  input { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 4px 6px; width: 100%; }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
</style>
</head>
<body>
  <p class="hint">Values are substituted into the script before it runs. Empty values stop the run.</p>
  ${rows}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    // Re-sending the whole list keeps the host free of per-keystroke diffing; the service ignores
    // values that did not change.
    for (const input of document.querySelectorAll('input')) {
      input.addEventListener('change', () => {
        vscode.postMessage({ type: 'change', name: input.dataset.name, value: input.value });
      });
    }
    // Focus the first empty input: on a script with several placeholders that is almost always the
    // one the user came here to fill in.
    const empty = [...document.querySelectorAll('input')].find((i) => i.value === '');
    if (empty) { empty.focus(); }
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    if (VariablePanel.current === this) {
      VariablePanel.current = undefined;
    }
  }
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
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
