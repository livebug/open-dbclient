import * as vscode from 'vscode';

import type { ConnectionProfileDraft } from '../model/ConnectionProfile';
import { emptyProfile } from '../model/ConnectionProfile';
import {
  formatProperties,
  parseProperties,
  validateJdbcUrl,
  validateProperties,
} from '../model/connectionProperties';
import type { ProbeResult } from '../bridge/protocol';
import { describeError, log } from '../util/logger';

/** What the form's inputs hold, as plain strings because that is what a text field produces. */
export interface ConnectionFormValues {
  name: string;
  driverClassName: string;
  url: string;
  user: string;
  password: string;
  properties: string;
  poolSize: string;
}

export interface DriverOption {
  className: string;
  label: string;
  /** Shown under the driver field: the jar it came from, or why a saved driver is listed. */
  detail?: string;
}

export interface ConnectionFormOptions {
  readonly extensionUri: vscode.Uri;
  readonly mode: 'add' | 'edit';
  readonly values: ConnectionFormValues;
  /** Whether a password is stored already, so a blank field can say so rather than look empty. */
  readonly hasStoredPassword: boolean;
  readonly drivers: readonly DriverOption[];
  /** Tests the form as typed. The profile does not have to exist yet. */
  readonly connect: (draft: ConnectionProfileDraft, password: string | undefined) => Promise<ProbeResult>;
  /** The URL to offer when the driver changes, given the rest of the form. */
  readonly suggestUrl?: (values: ConnectionFormValues) => string | undefined;
}

export interface ConnectionFormResult {
  readonly draft: ConnectionProfileDraft;
  /** Undefined means "keep whatever is stored"; a string replaces it. */
  readonly password?: string;
  readonly tested: boolean;
}

/**
 * A single-page form for creating or editing a connection.
 *
 * Replaced a sequence of input boxes. The deciding factor was testing: a connection is only worth
 * testing once the URL, credentials and properties are all filled in, and there is no way to do that
 * from a chain of modal prompts without saving first. A form also makes the fields that only make
 * sense together - host, port and the URL derived from them - visible at the same time.
 *
 * `show` resolves with the result, or undefined when the panel is dismissed, so callers can await it
 * as if it were a prompt.
 */
export class ConnectionFormPanel {
  /** Opens the form and resolves with what the user confirmed, if anything. */
  static async show(options: ConnectionFormOptions): Promise<ConnectionFormResult | undefined> {
    return new Promise<ConnectionFormResult | undefined>((resolve) => {
      const panel = vscode.window.createWebviewPanel(
        'open-dbclient.connectionForm',
        options.mode === 'add' ? 'Add Connection' : 'Edit Connection',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, 'media')],
        },
      );

      let settled = false;
      const finish = (value: ConnectionFormResult | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
        panel.dispose();
      };

      let lastTestPassed = options.mode === 'edit';

      panel.webview.html = renderHtml(panel.webview, options.extensionUri);
      panel.iconPath = new vscode.ThemeIcon('plug');

      panel.webview.onDidReceiveMessage(async (message: unknown) => {
        const typed = message as { type?: string; values?: ConnectionFormValues };
        switch (typed.type) {
          case 'ready':
            await panel.webview.postMessage({
              type: 'init',
              state: {
                mode: options.mode,
                values: options.values,
                hasStoredPassword: options.hasStoredPassword,
                drivers: options.drivers,
              },
            });
            return;

          case 'driverChanged': {
            const values = { ...options.values, driverClassName: typed.values?.driverClassName ?? '' };
            const suggested = options.suggestUrl?.(values);
            if (suggested) {
              await panel.webview.postMessage({ type: 'suggestedUrl', url: suggested });
            }
            return;
          }

          case 'test': {
            const values = typed.values ?? options.values;
            const problem = firstProblem(values, false);
            if (problem) {
              await panel.webview.postMessage({ type: 'testResult', outcome: { ok: false, message: problem } });
              return;
            }

            await panel.webview.postMessage({ type: 'testing' });
            try {
              const result = await options.connect(
                toDraft(values, undefined),
                values.password.length > 0 ? values.password : undefined,
              );
              lastTestPassed = true;
              await panel.webview.postMessage({
                type: 'testResult',
                outcome: {
                  ok: true,
                  message: `Connected in ${result.connectMillis} ms. ${result.capabilities.description}`,
                },
              });
            } catch (error) {
              lastTestPassed = false;
              await panel.webview.postMessage({
                type: 'testResult',
                outcome: { ok: false, message: describeError(error) },
              });
            }
            return;
          }

          case 'save': {
            const values = typed.values ?? options.values;
            const problem = firstProblem(values, true);
            if (problem) {
              await panel.webview.postMessage({ type: 'error', message: problem });
              return;
            }
            if (!lastTestPassed) {
              // The Save button is disabled until a test passes; this is the guard for a message that
              // arrives anyway, from a stale panel or a script that bypasses the button.
              await panel.webview.postMessage({
                type: 'error',
                message: 'Test the connection before saving it.',
              });
              return;
            }
            finish({
              draft: toDraft(values, options.mode === 'edit' ? options.values.name : undefined),
              password: values.password.length > 0 ? values.password : undefined,
              tested: true,
            });
            return;
          }

          case 'cancel':
            finish(undefined);
            return;

          default:
            log.debug(`The connection form ignored an unknown message: ${String(typed.type)}`);
        }
      });

      panel.onDidDispose(() => finish(undefined));
    });
  }
}

/** The first thing wrong with the form, or undefined when it may be submitted. */
function firstProblem(values: ConnectionFormValues, requireName: boolean): string | undefined {
  if (requireName && values.name.trim() === '') {
    return 'A name is required';
  }
  return validateJdbcUrl(values.url) ?? validateProperties(values.properties);
}

/**
 * Converts what the form holds into a profile draft.
 *
 * `nameFallback` is used when the name is blank, which happens while editing: the name field is not
 * required to test a connection, and testing must not lose the stored name.
 */
function toDraft(values: ConnectionFormValues, nameFallback: string | undefined): ConnectionProfileDraft {
  return {
    ...emptyProfile(),
    name: values.name.trim() || nameFallback || values.url.trim(),
    driverClassName: values.driverClassName.trim(),
    url: values.url.trim(),
    user: values.user.trim() || undefined,
    properties: parseProperties(values.properties),
    savePassword: true,
  };
}

/** The values to open the form with for an existing profile. */
export function valuesFor(
  profile: { name: string; driverClassName: string; url: string; user?: string; properties?: Record<string, string> },
): ConnectionFormValues {
  return {
    name: profile.name,
    driverClassName: profile.driverClassName,
    url: profile.url,
    user: profile.user ?? '',
    // Never prefilled: the stored password is not read back into the page.
    password: '',
    properties: formatProperties(profile.properties),
    poolSize: '',
  };
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'connection', 'main.js'),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'connection', 'style.css'),
  );
  const nonce = createNonce();

  const contentSecurityPolicy = [
    "default-src 'none'",
    `img-src ${webview.cspSource}`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Connection</title>
</head>
<body>
  <h1 id="heading">Connection</h1>
  <p class="lede">Test the connection before saving it. Nothing is stored until it works.</p>
  <form id="form" autocomplete="off">
    <label for="driverClassName">Driver</label>
    <select id="driverClassName" name="driverClassName"></select>
    <div class="hint" id="driverHint"></div>

    <label for="name">Name</label>
    <input id="name" name="name" type="text" spellcheck="false" placeholder="A label for this connection">

    <label for="url">JDBC URL</label>
    <input id="url" name="url" type="text" spellcheck="false" placeholder="jdbc:postgresql://host:5432/db">

    <label for="user">User</label>
    <input id="user" name="user" type="text" spellcheck="false" placeholder="Leave empty when the URL carries the credentials">

    <label for="password">Password</label>
    <input id="password" name="password" type="password" spellcheck="false">
    <div class="hint" id="passwordHint" hidden>Leave empty to keep the stored password.</div>

    <label for="properties">Properties</label>
    <textarea id="properties" name="properties" spellcheck="false" placeholder="key=value;key=value"></textarea>
    <div class="hint">Extra JDBC properties, separated by semicolons.</div>

    <div class="buttons">
      <button type="button" id="test">Test Connection</button>
      <button type="submit" id="save" disabled>Save</button>
      <div id="spacer"></div>
      <span id="result" role="status" aria-live="polite"></span>
      <button type="button" id="cancel" class="secondary">Cancel</button>
    </div>
    <div class="hint" id="saveHint" hidden>Test the connection to enable Save.</div>
  </form>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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
