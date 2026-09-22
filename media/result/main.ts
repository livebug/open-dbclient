/**
 * The result grid.
 *
 * Renders whatever page of rows the extension has sent using virtual scrolling: only the rows inside
 * the viewport (plus a small overscan) exist in the DOM, so a result of a million rows costs the same
 * to display as one of fifty.
 *
 * Virtual scrolling is implemented with spacer rows inside a real `<table>` rather than absolutely
 * positioned divs. A table gives column alignment between the header and the body for free, which the
 * div approach has to reimplement and then keep in sync as content changes.
 */

import type {
  GridColumn,
  GridValue,
  HostToWebviewMessage,
  WebviewToHostMessage,
} from '../../src/webview/messages';

declare function acquireVsCodeApi<T = unknown>(): {
  postMessage(message: WebviewToHostMessage): void;
  getState(): T | undefined;
  setState(state: T): void;
};

const vscode = acquireVsCodeApi();

/** Row height in pixels; must match the value in the stylesheet. */
const ROW_HEIGHT = 22;

/** Rows rendered beyond the viewport, so scrolling does not reveal blank space. */
const OVERSCAN = 8;

/** Numeric types are right-aligned, matching how spreadsheets present them. */
const NUMERIC_TYPES = new Set([
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'DECIMAL',
  'NUMERIC',
  'FLOAT',
  'REAL',
  'DOUBLE',
]);

interface ViewState {
  mode: 'empty' | 'running' | 'result' | 'update' | 'error';
  columns: GridColumn[];
  rows: GridValue[][];
  offset: number;
  totalRows: number;
  pageSize: number;
  sql: string;
  connectionName: string;
  elapsedMillis: number;
  truncated: boolean;
  truncatedAt?: number;
  message?: string;
  sqlState?: string;
  errorCode?: string;
  busy: boolean;
}

const state: ViewState = {
  mode: 'empty',
  columns: [],
  rows: [],
  offset: 0,
  totalRows: 0,
  pageSize: 200,
  sql: '',
  connectionName: '',
  elapsedMillis: 0,
  truncated: false,
  busy: false,
};

const viewport = document.getElementById('viewport') as HTMLDivElement;
const toolbar = document.getElementById('toolbar') as HTMLDivElement;
const statusBar = document.getElementById('status') as HTMLDivElement;
const table = document.getElementById('grid') as HTMLTableElement;
const head = table.querySelector('thead') as HTMLTableSectionElement;
const body = table.querySelector('tbody') as HTMLTableSectionElement;

let contextMenu: HTMLDivElement | undefined;
let detailPanel: HTMLDivElement | undefined;
let selectedCell: HTMLTableCellElement | undefined;
let renderScheduled = false;

// ---------------------------------------------------------------------------
// message handling
// ---------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'running':
      state.mode = 'running';
      state.sql = message.sql;
      state.connectionName = message.connectionName;
      state.busy = true;
      state.columns = [];
      state.rows = [];
      render();
      break;

    case 'result':
      state.mode = 'result';
      state.columns = [...message.columns];
      state.rows = message.rows.map((row) => [...row]);
      state.offset = message.offset;
      state.totalRows = message.totalRows;
      state.pageSize = message.pageSize;
      state.sql = message.sql;
      state.connectionName = message.connectionName;
      state.elapsedMillis = message.elapsedMillis;
      state.truncated = message.truncated;
      state.truncatedAt = message.truncatedAt;
      state.message = undefined;
      state.busy = false;
      viewport.scrollTop = 0;
      render();
      break;

    case 'update':
      state.mode = 'update';
      state.sql = message.sql;
      state.connectionName = message.connectionName;
      state.elapsedMillis = message.elapsedMillis;
      state.message = `${message.updateCount.toLocaleString()} row(s) affected.`;
      state.busy = false;
      render();
      break;

    case 'error':
      state.mode = 'error';
      state.sql = message.sql;
      state.connectionName = message.connectionName;
      state.message = message.message;
      state.sqlState = message.sqlState;
      state.errorCode = message.code;
      state.busy = false;
      render();
      break;

    case 'page':
      state.rows = message.rows.map((row) => [...row]);
      state.offset = message.offset;
      state.totalRows = message.totalRows;
      state.busy = false;
      render();
      break;

    case 'pageError':
      state.busy = false;
      state.message = message.message;
      renderStatus();
      break;

    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function render(): void {
  renderToolbar();
  renderContent();
  renderStatus();
}

function renderToolbar(): void {
  toolbar.replaceChildren();

  if (state.mode === 'result') {
    const total = state.totalRows;
    const first = total === 0 ? 0 : state.offset + 1;
    const last = state.offset + state.rows.length;

    toolbar.append(
      button('First', () => requestPage(0), { disabled: state.busy || state.offset === 0 }),
      button('Previous', () => requestPage(Math.max(0, state.offset - state.pageSize)), {
        disabled: state.busy || state.offset === 0,
      }),
      text(`Rows ${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`),
      button('Next', () => requestPage(state.offset + state.pageSize), {
        disabled: state.busy || last >= total,
      }),
      button('Last', () => requestPage(lastPageOffset()), {
        disabled: state.busy || last >= total,
      }),
      separator(),
      text('Go to row'),
      numberInput(state.offset + 1, (value) => {
        const target = Math.max(0, Math.min(value - 1, Math.max(0, total - 1)));
        requestPage(target - (target % state.pageSize));
      }),
    );
  }

  toolbar.append(spacer());

  if (state.mode === 'result') {
    toolbar.append(button('Export…', () => post({ type: 'export' }), { primary: true }));
  }
  if (state.busy) {
    toolbar.append(button('Cancel', () => post({ type: 'cancel' })));
  } else if (state.sql) {
    toolbar.append(button('Run again', () => post({ type: 'rerun' })));
  }
}

function renderContent(): void {
  head.replaceChildren();
  body.replaceChildren();

  if (state.mode !== 'result') {
    const placeholder = document.createElement('div');
    placeholder.id = 'placeholder';
    if (state.mode === 'error') {
      placeholder.classList.add('error');
    }

    if (state.mode === 'running') {
      placeholder.textContent = 'Running…';
    } else if (state.mode === 'error') {
      placeholder.textContent = state.message ?? 'The statement failed.';
      if (state.sqlState) {
        placeholder.textContent += `\n\nSQLState: ${state.sqlState}`;
      }
    } else if (state.mode === 'update') {
      placeholder.textContent = state.message ?? 'The statement completed.';
    } else {
      placeholder.textContent = 'Run a query to see results here.';
    }

    if (state.sql) {
      const statement = document.createElement('code');
      statement.className = 'statement';
      statement.textContent = state.sql;
      placeholder.append(statement);
    }

    // The placeholder replaces the table entirely, so the grid cannot show stale rows underneath.
    const wrapper = document.createElement('div');
    wrapper.append(placeholder);
    viewport.replaceChildren(wrapper);
    return;
  }

  // Restore the table, which renderContent may have swapped out for a placeholder.
  if (!viewport.contains(table)) {
    viewport.replaceChildren(table);
  }

  const headerRow = document.createElement('tr');

  const gutterHead = document.createElement('th');
  gutterHead.className = 'row-number';
  gutterHead.textContent = '#';
  headerRow.append(gutterHead);

  for (const column of state.columns) {
    const cell = document.createElement('th');
    const name = document.createElement('span');
    name.textContent = column.label;
    if (column.tableName) {
      cell.title = `${column.tableName}.${column.name} (${column.displayType})`;
    } else {
      cell.title = `${column.name} (${column.displayType})`;
    }
    const type = document.createElement('span');
    type.className = 'type';
    type.textContent = column.displayType;
    cell.append(name, type);
    headerRow.append(cell);
  }
  head.append(headerRow);

  renderVisibleRows();
}

/**
 * Renders only the rows the viewport can show.
 *
 * The two spacer rows carry the height of the rows above and below the window, which makes the
 * scrollbar represent the whole result while the DOM holds only a screenful.
 */
function renderVisibleRows(): void {
  body.replaceChildren();

  const total = state.rows.length;
  if (total === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = state.columns.length + 1;
    cell.textContent = 'No rows returned.';
    cell.style.textAlign = 'center';
    cell.style.color = 'var(--vscode-descriptionForeground)';
    row.append(cell);
    body.append(row);
    return;
  }

  const scrollTop = viewport.scrollTop;
  const visibleCount = Math.ceil(viewport.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(total, first + visibleCount);

  body.append(spacerRow(first * ROW_HEIGHT));

  for (let index = first; index < last; index++) {
    body.append(renderRow(index));
  }

  body.append(spacerRow((total - last) * ROW_HEIGHT));
}

function renderRow(index: number): HTMLTableRowElement {
  const row = document.createElement('tr');

  const gutter = document.createElement('td');
  gutter.className = 'row-number';
  gutter.textContent = (state.offset + index + 1).toLocaleString();
  row.append(gutter);

  for (let columnIndex = 0; columnIndex < state.columns.length; columnIndex++) {
    const column = state.columns[columnIndex];
    const value = state.rows[index]?.[columnIndex] ?? null;
    const cell = document.createElement('td');

    if (NUMERIC_TYPES.has(column.jdbcTypeName)) {
      cell.classList.add('numeric');
    }

    if (value === null) {
      const nullMarker = document.createElement('span');
      nullMarker.className = 'null';
      nullMarker.textContent = 'NULL';
      cell.append(nullMarker);
    } else {
      const text = formatCell(value);
      cell.textContent = text;
      if (text.length > 80) {
        cell.title = 'Double-click to see the full value';
      }
    }

    // Retained so the context menu knows which value was clicked.
    cell.dataset.row = String(index);
    cell.dataset.column = String(columnIndex);
    row.append(cell);
  }

  return row;
}

function spacerRow(height: number): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = 'spacer';
  const cell = document.createElement('td');
  cell.colSpan = state.columns.length + 1;
  cell.style.height = `${Math.max(0, height)}px`;
  row.append(cell);
  return row;
}

function renderStatus(): void {
  statusBar.replaceChildren();

  if (state.mode === 'result') {
    statusBar.append(
      text(`${state.totalRows.toLocaleString()} row(s)`),
      text(`${state.columns.length} column(s)`),
      text(formatDuration(state.elapsedMillis)),
    );
    if (state.truncated) {
      const warning = document.createElement('span');
      warning.className = 'warning';
      warning.textContent =
        `Truncated at ${(state.truncatedAt ?? 0).toLocaleString()} rows. ` +
        'Export to get everything.';
      statusBar.append(warning);
    }
  } else if (state.mode === 'update') {
    statusBar.append(text(state.message ?? ''), text(formatDuration(state.elapsedMillis)));
  } else if (state.mode === 'error') {
    const error = document.createElement('span');
    error.className = 'warning';
    error.textContent = state.errorCode ?? 'ERROR';
    statusBar.append(error);
  }

  statusBar.append(spacer());
  if (state.connectionName) {
    statusBar.append(text(state.connectionName));
  }
  if (state.busy) {
    statusBar.append(text('Running…'));
  }
}

// ---------------------------------------------------------------------------
// interaction
// ---------------------------------------------------------------------------

viewport.addEventListener('scroll', () => {
  // A scroll event fires many times per frame; coalescing to one render per frame keeps it smooth.
  if (renderScheduled || state.mode !== 'result') {
    return;
  }
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderVisibleRows();
  });
});

window.addEventListener('resize', () => {
  if (state.mode === 'result') {
    renderVisibleRows();
  }
});

table.addEventListener('dblclick', (event) => {
  const cell = (event.target as HTMLElement).closest('td');
  if (!cell || cell.classList.contains('row-number')) {
    return;
  }
  const value = valueForCell(cell);
  showDetail(value);
});

table.addEventListener('contextmenu', (event) => {
  const cell = (event.target as HTMLElement).closest('td');
  if (!cell || cell.classList.contains('row-number')) {
    return;
  }
  event.preventDefault();
  selectCell(cell);
  showContextMenu(event.clientX, event.clientY, cell);
});

document.addEventListener('click', (event) => {
  if (contextMenu && !contextMenu.contains(event.target as Node)) {
    closeContextMenu();
  }
  if (detailPanel && !detailPanel.contains(event.target as Node)) {
    closeDetail();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeContextMenu();
    closeDetail();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && selectedCell) {
    // Let the browser handle a text selection, but make a plain cell click copyable.
    if (!window.getSelection()?.toString()) {
      void copyText(valueForCell(selectedCell));
    }
  }
});

function selectCell(cell: HTMLTableCellElement): void {
  selectedCell?.classList.remove('selected');
  selectedCell = cell;
  cell.classList.add('selected');
}

function showContextMenu(x: number, y: number, cell: HTMLTableCellElement): void {
  closeContextMenu();

  contextMenu = document.createElement('div');
  contextMenu.id = 'context-menu';

  const rowIndex = Number(cell.dataset.row);
  const columnIndex = Number(cell.dataset.column);

  contextMenu.append(
    button('Copy value', () => copyText(valueForCell(cell))),
    button('Copy column name', () => copyText(state.columns[columnIndex]?.label ?? '')),
    button('Copy row', () => copyText(rowToText(rowIndex))),
    button('Copy row as JSON', () => copyText(rowToJson(rowIndex))),
    button('Copy all column names', () => copyText(state.columns.map((column) => column.label).join('\t'))),
  );

  // Positioned within the viewport, flipping when the click is near an edge.
  document.body.append(contextMenu);
  const rect = contextMenu.getBoundingClientRect();
  contextMenu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
}

function closeContextMenu(): void {
  contextMenu?.remove();
  contextMenu = undefined;
}

function showDetail(value: GridValue): void {
  closeDetail();

  detailPanel = document.createElement('div');
  detailPanel.id = 'detail';

  const header = document.createElement('header');
  const title = document.createElement('span');
  title.textContent = 'Value';
  header.append(title, spacer(), button('Close', () => closeDetail()));

  const content = document.createElement('pre');
  content.textContent = value === null ? 'NULL' : formatCell(value);

  detailPanel.append(header, content);
  document.body.append(detailPanel);
}

function closeDetail(): void {
  detailPanel?.remove();
  detailPanel = undefined;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    // The clipboard API rejects without focus, which happens after a context menu closes.
    post({ type: 'report', message: `Could not copy to the clipboard: ${String(error)}` });
  }
  closeContextMenu();
}

function requestPage(offset: number): void {
  if (state.busy) {
    return;
  }
  state.busy = true;
  renderToolbar();
  post({ type: 'requestPage', offset: Math.max(0, offset), limit: state.pageSize });
}

function lastPageOffset(): number {
  if (state.totalRows <= 0) {
    return 0;
  }
  return Math.floor((state.totalRows - 1) / state.pageSize) * state.pageSize;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Renders a cell value as text.
 *
 * Numbers arrive either as JSON numbers or as strings when a value was too precise for a double; both
 * are displayed verbatim, since reformatting a number the database sent as text is exactly the
 * precision loss the string form exists to avoid.
 */
function formatCell(value: GridValue): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function valueForCell(cell: HTMLTableCellElement): GridValue {
  const rowIndex = Number(cell.dataset.row);
  const columnIndex = Number(cell.dataset.column);
  return state.rows[rowIndex]?.[columnIndex] ?? null;
}

function rowToText(rowIndex: number): string {
  const row = state.rows[rowIndex] ?? [];
  return row.map((value) => (value === null ? '' : formatCell(value))).join('\t');
}

function rowToJson(rowIndex: number): string {
  const row = state.rows[rowIndex] ?? [];
  const object: Record<string, GridValue> = {};
  const seen = new Set<string>();

  state.columns.forEach((column, index) => {
    // Duplicate labels are legal in SQL and would collapse in an object, so later ones are suffixed.
    let key = column.label || `column_${index + 1}`;
    let suffix = 2;
    while (seen.has(key)) {
      key = `${column.label}_${suffix++}`;
    }
    seen.add(key);
    object[key] = row[index] ?? null;
  });

  return JSON.stringify(object, null, 2);
}

function post(message: WebviewToHostMessage): void {
  vscode.postMessage(message);
}

function text(content: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.textContent = content;
  return span;
}

function spacer(): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'spacer';
  return span;
}

function separator(): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'separator';
  return span;
}

function button(
  label: string,
  onClick: () => void,
  options?: { disabled?: boolean; primary?: boolean },
): HTMLButtonElement {
  const element = document.createElement('button');
  element.textContent = label;
  element.disabled = options?.disabled === true;
  if (options?.primary) {
    element.classList.add('primary');
  }
  element.addEventListener('click', onClick);
  return element;
}

function numberInput(value: number, onChange: (value: number) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.value = String(value);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const parsed = Number(input.value);
      if (Number.isFinite(parsed) && parsed >= 1) {
        onChange(Math.floor(parsed));
      }
    }
  });
  return input;
}

function formatDuration(millis: number): string {
  if (millis < 1000) {
    return `${millis} ms`;
  }
  return `${(millis / 1000).toFixed(2)} s`;
}

// Tell the host the DOM is ready so it can send the pending state.
post({ type: 'ready' });
