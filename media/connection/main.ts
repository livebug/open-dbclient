/**
 * Script for the connection form webview.
 *
 * A form rather than a sequence of input boxes, because a connection has fields that only make sense
 * together - the URL is derived from the host and port, and testing only means something once the
 * whole set is filled in. Keeping the values in one document is what makes a Test button possible
 * before anything is saved.
 *
 * The host owns validation that needs the extension (does the URL start with jdbc:, are properties
 * key=value); this file only reports what the user typed and renders what comes back.
 */

export interface FormValues {
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
  detail: string;
}

export interface InitialState {
  mode: 'add' | 'edit';
  values: FormValues;
  /** True when a password is already stored, so the blank field does not read as "no password". */
  hasStoredPassword: boolean;
  drivers: DriverOption[];
}

interface TestOutcome {
  ok: boolean;
  message: string;
}

declare function acquireVsCodeApi<T = unknown>(): {
  postMessage(message: unknown): void;
  getState(): T | undefined;
  setState(state: T): void;
};

interface HostMessage {
  type: 'init' | 'testResult' | 'testing' | 'error' | 'suggestedUrl';
  state?: InitialState;
  outcome?: TestOutcome;
  message?: string;
  url?: string;
}

const vscode = acquireVsCodeApi();

const FIELDS: readonly (keyof FormValues)[] = [
  'name',
  'driverClassName',
  'url',
  'user',
  'password',
  'properties',
  'poolSize',
];

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`the form is missing #${id}`);
  }
  return found as T;
}

const form = element<HTMLFormElement>('form');
const driverSelect = element<HTMLSelectElement>('driverClassName');
const driverHint = element<HTMLDivElement>('driverHint');
const testButton = element<HTMLButtonElement>('test');
const saveButton = element<HTMLButtonElement>('save');
const cancelButton = element<HTMLButtonElement>('cancel');
const result = element<HTMLDivElement>('result');

/** The name of the driver that was selected, so its hint can be shown. */
let selectedDriver = '';

function readValues(): FormValues {
  const values = {} as FormValues;
  for (const field of FIELDS) {
    const input = document.getElementById(field);
    values[field] = input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement
      ? input.value
      : '';
  }
  return values;
}

function fill(values: FormValues): void {
  for (const field of FIELDS) {
    const input = document.getElementById(field);
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      input.value = values[field] ?? '';
    }
  }
}

function setBusy(busy: boolean): void {
  testButton.disabled = busy;
  saveButton.disabled = busy;
  testButton.textContent = busy ? 'Testing…' : 'Test Connection';
}

function showResult(outcome: TestOutcome | undefined): void {
  result.className = outcome === undefined ? '' : outcome.ok ? 'ok' : 'bad';
  result.textContent = outcome?.message ?? '';
}

function applyState(state: InitialState): void {
  selectedDriver = state.values.driverClassName;

  // Only drivers the extension actually loaded are offered, plus whatever the saved profile already
  // names - a connection must not be silently rewritten to a different driver by opening the form.
  const options = [...state.drivers];
  if (selectedDriver && !options.some((option) => option.className === selectedDriver)) {
    options.unshift({ className: selectedDriver, label: selectedDriver, detail: 'saved driver' });
  }
  driverSelect.replaceChildren();
  if (options.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No driver is loaded';
    driverSelect.append(option);
    driverSelect.disabled = true;
  } else {
    driverSelect.disabled = false;
    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.className;
      node.textContent = option.label;
      node.title = option.detail;
      driverSelect.append(node);
    }
  }
  driverSelect.value = selectedDriver;

  const hint = options.find((option) => option.className === selectedDriver);
  driverHint.textContent = hint?.detail ?? '';

  fill(state.values);

  if (state.mode === 'edit') {
    element<HTMLElement>('passwordHint').hidden = !state.hasStoredPassword;
  }

  document.title = state.mode === 'add' ? 'Add Connection' : 'Edit Connection';
  element<HTMLElement>('heading').textContent = document.title;

  // Nothing to save until the connection has been shown to work at least once - except when editing,
  // where the saved values are known to have worked already.
  saveButton.disabled = state.mode === 'edit' ? false : true;
  element<HTMLElement>('saveHint').hidden = state.mode === 'edit';
}

driverSelect.addEventListener('change', () => {
  selectedDriver = driverSelect.value;
  // Changing the driver invalidates a previous test, and usually the URL as well.
  saveButton.disabled = true;
  showResult(undefined);
  vscode.postMessage({ type: 'driverChanged', driverClassName: selectedDriver });
});

testButton.addEventListener('click', () => {
  setBusy(true);
  showResult(undefined);
  vscode.postMessage({ type: 'test', values: readValues() });
});

saveButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'save', values: readValues() });
});

cancelButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'cancel' });
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!saveButton.disabled) {
    saveButton.click();
  }
});

// Any edit invalidates the previous test result, so Save goes back to being unavailable until the
// current values have been tested. This is the whole point of the button being disabled by default.
form.addEventListener('input', () => {
  if (!saveButton.disabled) {
    return;
  }
  // Editing after a successful test means the result no longer describes what would be saved.
  if (result.classList.contains('ok')) {
    saveButton.disabled = true;
    showResult(undefined);
  }
});

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      if (message.state) {
        applyState(message.state);
      }
      break;
    case 'testing':
      setBusy(true);
      break;
    case 'suggestedUrl': {
      // Only fills an empty URL. Replacing what is already there would throw away a URL the user
      // typed, and there is no way to tell a typed URL from one filled in a moment ago.
      const urlField = element<HTMLInputElement>('url');
      if (urlField.value.trim() === '' && message.url) {
        urlField.value = message.url;
      }
      break;
    }
    case 'testResult':
      setBusy(false);
      showResult(message.outcome);
      if (message.outcome?.ok) {
        saveButton.disabled = false;
        element<HTMLElement>('saveHint').hidden = true;
      }
      break;
    case 'error':
      setBusy(false);
      showResult({ ok: false, message: message.message ?? 'Something went wrong.' });
      break;
    default:
      break;
  }
});

vscode.postMessage({ type: 'ready' });
