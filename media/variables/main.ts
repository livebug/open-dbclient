/**
 * The SQL script variables view.
 *
 * The document is static and this script owns the rows: it is created once, and afterwards only the
 * values that changed are written. Rebuilding the DOM on every change is what made the old panel
 * flicker and drop focus mid-typing, and the rows below are therefore never replaced - a row is added
 * when a placeholder appears, updated when its value changes, and removed when the placeholder is
 * deleted from the script.
 */

import { setLocale, t } from '../../src/util/i18n';

interface VariableRow {
  readonly name: string;
  readonly value: string;
}

interface StateMessage {
  readonly type: 'state';
  readonly rows: readonly VariableRow[];
  readonly locale?: string;
}

declare function acquireVsCodeApi<T = unknown>(): {
  postMessage(message: unknown): void;
  getState(): T | undefined;
  setState(state: T): void;
};

const vscode = acquireVsCodeApi();

const container = document.getElementById('rows') as HTMLDivElement;
const hint = document.getElementById('hint') as HTMLParagraphElement;

/** Existing rows, keyed by placeholder name, so a state update can reuse them. */
const rows = new Map<string, HTMLLabelElement>();

window.addEventListener('message', (event: MessageEvent<StateMessage>) => {
  const message = event.data;
  if (message?.type !== 'state') {
    return;
  }
  // The host reports its display language, so a webview restored in another window still translates.
  setLocale(message.locale ?? document.documentElement.lang);
  apply(message.rows);
});

function apply(state: readonly VariableRow[]): void {
  const wanted = new Set(state.map((row) => row.name));

  for (const [name, row] of [...rows]) {
    if (!wanted.has(name)) {
      row.remove();
      rows.delete(name);
    }
  }

  hint.textContent = state.length === 0
    ? t('This script has no ${NAME} placeholders.')
    : t('Values are substituted before the statement runs. A placeholder with no value stops the run.');

  for (const entry of state) {
    let row = rows.get(entry.name);
    if (!row) {
      row = createRow(entry.name);
      rows.set(entry.name, row);
    }

    const input = row.querySelector('input') as HTMLInputElement;
    // The host echoes every change back. Writing the value into the input the user is typing into
    // would move the caret to the end on each keystroke, so the focused input is left alone.
    if (document.activeElement !== input && input.value !== entry.value) {
      input.value = entry.value;
    }

    // Re-appending moves the existing node, which keeps its focus and caret - unlike re-creating it.
    container.append(row);
  }
}

function createRow(name: string): HTMLLabelElement {
  const row = document.createElement('label');
  row.className = 'row';

  const label = document.createElement('span');
  label.className = 'name';
  // Written as the user writes it in the script, so the two can be matched by eye.
  label.textContent = '${' + name + '}';

  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = t('value');
  input.dataset.name = name;
  input.addEventListener('input', () => {
    vscode.postMessage({ type: 'change', name, value: input.value });
  });

  row.append(label, input);
  return row;
}

// When the tab is brought forward, the reason was almost always an unfilled value, so the first one
// is focused. Done on visibility rather than on every update, which would fight the user.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    return;
  }
  const empty = [...rows.values()].find((row) => {
    const input = row.querySelector('input') as HTMLInputElement;
    return input.value === '';
  });
  (empty?.querySelector('input') as HTMLInputElement | null)?.focus();
});

vscode.postMessage({ type: 'ready' });
