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
  GridCellEdit,
  GridColumn,
  GridRowForSql,
  GridStatementKind,
  GridValue,
  HostToWebviewMessage,
  WebviewToHostMessage,
} from '../../src/webview/messages';
import { setLocale, t } from '../../src/util/i18n';
import { countStatement } from '../../src/sql/statementBuilder.ts';

declare function acquireVsCodeApi<T = unknown>(): {
  postMessage(message: WebviewToHostMessage): void;
  getState(): T | undefined;
  setState(state: T): void;
};

const vscode = acquireVsCodeApi();

// The host writes its display language into the document's `lang` attribute, so the catalog here
// follows the same language the rest of the UI is in without a second message to keep in step.
setLocale(document.documentElement.lang);

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
let renderScheduled = false;

/** The slice of rows currently in the DOM, used to skip redundant rebuilds on scroll. */
let renderedWindow:
  | { first: number; last: number; total: number; columns: number; offset: number }
  | undefined;

/** Height of the sticky header, re-measured whenever the table content is rebuilt. */
let headerHeight = 0;

/** A cell address: an absolute row index in the result, and a column index. */
interface CellRef {
  readonly row: number;
  readonly column: number;
}

/**
 * Edits the user has made, keyed by {@link editKey}.
 *
 * Keyed by the *absolute* row index rather than by position in the rendered window, because the row
 * the user edited has to still be theirs after a page change or a scroll: the window holds a few dozen
 * rows, the edits belong to the result.
 */
const pending = new Map<string, GridCellEdit>();

/** The selected range. Both ends are absolute row indexes, so it survives paging and scrolling. */
let selection: { anchor: CellRef; focus: CellRef } | undefined;

/** The cell being typed into right now, if any. */
let editing: CellRef | undefined;

/** The true total, once the user has asked for it; undefined means the count has not been run. */
let countedTotal: number | undefined;

/** The columns the host will use to identify a row, as it reported them. */
let identityNames: readonly string[] = [];

/** A one-line note from the host: a generated statement, or why one could not be written. */
let notice: string | undefined;

function editKey(row: number, column: number): string {
  return `${row}|${column}`;
}

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
      resetDerivedState();
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
      // A new result describes different rows: edits, a selection and a total counted for the old
      // result would all be attached to the wrong data.
      resetDerivedState();
      render();
      break;

    case 'update':
      state.mode = 'update';
      state.sql = message.sql;
      state.connectionName = message.connectionName;
      state.elapsedMillis = message.elapsedMillis;
      state.message = t('{0} row(s) affected.', message.updateCount.toLocaleString());
      state.busy = false;
      resetDerivedState();
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
      // A page that arrived is the answer to whatever the last failure was about.
      state.message = undefined;
      // Edits and the selection are keyed by absolute row index, so a page change must not clear them:
      // the rows the user changed scroll back into view with their changes still on them.
      render();
      break;

    case 'pageError':
      state.busy = false;
      state.message = message.message;
      // `render()`, not `renderStatus()`: the disabled state of the paging buttons is drawn by
      // renderToolbar, so updating only the status left every button disabled for good after one
      // failed fetch. The message itself has to be visible too, which renderStatus now does.
      render();
      break;

    case 'totalCount':
      countedTotal = message.total;
      renderStatus();
      break;

    case 'countFailed':
      notice = message.message;
      renderStatus();
      break;

    case 'sqlReady':
      notice =
        message.warnings.length > 0
          ? t(
              '{0} statement(s) copied, with warnings: {1}',
              message.statements,
              message.warnings.join(' · '),
            )
          : t('{0} statement(s) copied and opened for review.', message.statements);
      renderStatus();
      break;

    case 'sqlFailed':
      notice = message.message;
      renderStatus();
      break;

    case 'identityColumns':
      identityNames = message.columns;
      renderStatus();
      break;

    case 'notice':
      notice = message.message;
      renderStatus();
      break;

    default:
      break;
  }
});

/** Clears everything derived from one result's rows: edits, selection, the count and any note. */
function resetDerivedState(): void {
  pending.clear();
  selection = undefined;
  editing = undefined;
  countedTotal = undefined;
  identityNames = [];
  notice = undefined;
}

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
      button(t('First'), () => requestPage(0), { disabled: state.busy || state.offset === 0 }),
      button(t('Previous'), () => requestPage(Math.max(0, state.offset - state.pageSize)), {
        disabled: state.busy || state.offset === 0,
      }),
      text(t('Rows {0}–{1} of {2}', first.toLocaleString(), last.toLocaleString(), total.toLocaleString())),
      button(t('Next'), () => requestPage(state.offset + state.pageSize), {
        disabled: state.busy || last >= total,
      }),
      button(t('Last'), () => requestPage(lastPageOffset()), {
        disabled: state.busy || last >= total,
      }),
      separator(),
      text(t('Go to row')),
      numberInput(state.offset + 1, (value) => {
        const target = Math.max(0, Math.min(value - 1, Math.max(0, total - 1)));
        requestPage(target - (target % state.pageSize));
      }),
    );

    // The number above is the row ceiling once the result was truncated, so the real total is a
    // separate question - asked for rather than run automatically, because counting a large table is
    // a full scan the user pays for.
    if (state.truncated) {
      toolbar.append(separator());
      toolbar.append(
        countedTotal === undefined
          ? button(t('Count all rows…'), () => post({ type: 'countRows' }), { disabled: state.busy })
          : text(t('{0} row(s) in total', countedTotal.toLocaleString())),
      );
    }
  }

  toolbar.append(spacer());

  if (state.mode === 'result') {
    if (pending.size > 0) {
      toolbar.append(
        text(t('{0} edit(s)', pending.size.toLocaleString())),
        button(t('Discard edits'), () => {
          pending.clear();
          editing = undefined;
          render();
        }),
      );
    }
    toolbar.append(
      button(t('SQL…'), (event) => {
        const anchor = (event.currentTarget as HTMLElement).getBoundingClientRect();
        showMenu(sqlMenuItems(), anchor.left, anchor.bottom + 2);
      }),
      button(t('Export…'), () => post({ type: 'export' }), { primary: true }),
    );
  }
  if (state.busy) {
    toolbar.append(button(t('Cancel'), () => post({ type: 'cancel' })));
  } else if (state.sql) {
    toolbar.append(button(t('Run again'), () => post({ type: 'rerun' })));
  }
}

function renderContent(): void {
  head.replaceChildren();
  body.replaceChildren();

  // The body is now empty, so the remembered window no longer describes what is in the DOM.
  renderedWindow = undefined;

  if (state.mode !== 'result') {
    const placeholder = document.createElement('div');
    placeholder.id = 'placeholder';
    if (state.mode === 'error') {
      placeholder.classList.add('error');
    }

    if (state.mode === 'running') {
      placeholder.textContent = t('Running…');
    } else if (state.mode === 'error') {
      placeholder.textContent = state.message ?? t('The statement failed.');
      if (state.sqlState) {
        placeholder.textContent += `\n\nSQLState: ${state.sqlState}`;
      }
    } else if (state.mode === 'update') {
      placeholder.textContent = state.message ?? t('The statement completed.');
    } else {
      placeholder.textContent = t('Run a query to see results here.');
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
    // The comment - where a database has one, the name people actually use - leads, and the physical
    // name stays visible underneath rather than being replaced. Showing only the comment would leave
    // the user unable to write the column into SQL; showing only the name is what made a
    // well-documented schema unreadable here in the first place.
    const comment = column.remarks?.trim() ? column.remarks.trim() : undefined;
    const qualified = column.tableName ? `${column.tableName}.${column.name}` : column.name;
    name.textContent = comment ?? column.label;
    const type = document.createElement('span');
    type.className = 'type';
    type.textContent = comment ? `${qualified} · ${column.displayType}` : column.displayType;
    cell.title = comment
      ? `${comment}\n${qualified} (${column.displayType})`
      : `${qualified} (${column.displayType})`;
    cell.append(name, type);
    headerRow.append(cell);
  }
  head.append(headerRow);

  // Measured once per content rebuild rather than on every scroll: the header is sticky, so the
  // scroll offset of the first data row is shifted by its height, and reading layout on each scroll
  // frame would force a style recalculation for no reason.
  headerHeight = head.getBoundingClientRect().height;

  renderVisibleRows(true);
}

/**
 * Renders only the rows the viewport can show.
 *
 * The two spacer rows carry the height of the rows above and below the window, which makes the
 * scrollbar represent the whole result while the DOM holds only a screenful.
 *
 * The window that was last drawn is remembered, and an unchanged window is left alone. Rebuilding the
 * body changes the table's height for a frame, which can bounce a scroll event straight back - so the
 * render fed itself, the grid flickered and the scrollbar appeared to fight the user. Skipping the
 * redundant work also means a scroll that stays within one row redraws nothing at all.
 */
function renderVisibleRows(force = false): void {
  const total = state.rows.length;
  const visibleCount = Math.ceil(viewport.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const first =
    total === 0
      ? 0
      : Math.max(0, Math.floor((viewport.scrollTop - headerHeight) / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(total, first + visibleCount);

  if (
    !force &&
    renderedWindow !== undefined &&
    renderedWindow.first === first &&
    renderedWindow.last === last &&
    renderedWindow.total === total &&
    renderedWindow.columns === state.columns.length &&
    renderedWindow.offset === state.offset
  ) {
    return;
  }
  renderedWindow = { first, last, total, columns: state.columns.length, offset: state.offset };

  body.replaceChildren();

  if (total === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = state.columns.length + 1;
    cell.textContent = t('No rows returned.');
    cell.style.textAlign = 'center';
    cell.style.color = 'var(--vscode-descriptionForeground)';
    row.append(cell);
    body.append(row);
    return;
  }

  body.append(spacerRow(first * ROW_HEIGHT));

  for (let index = first; index < last; index++) {
    body.append(renderRow(index));
  }

  body.append(spacerRow((total - last) * ROW_HEIGHT));
}

function renderRow(index: number): HTMLTableRowElement {
  const row = document.createElement('tr');
  const absolute = state.offset + index;

  const gutter = document.createElement('td');
  gutter.className = 'row-number';
  gutter.textContent = (absolute + 1).toLocaleString();
  if (rowIsDirty(absolute)) {
    gutter.classList.add('dirty');
    gutter.title = t('This row has edits that have not been written out');
  }
  row.append(gutter);

  for (let columnIndex = 0; columnIndex < state.columns.length; columnIndex++) {
    const column = state.columns[columnIndex];
    const cell = document.createElement('td');

    if (NUMERIC_TYPES.has(column.jdbcTypeName)) {
      cell.classList.add('numeric');
    }
    if (isSelected(absolute, columnIndex)) {
      cell.classList.add('selected');
    }
    if (pending.has(editKey(absolute, columnIndex))) {
      cell.classList.add('dirty');
    }

    // Retained so the context menu knows which value was clicked.
    cell.dataset.row = String(index);
    cell.dataset.column = String(columnIndex);

    if (editing && editing.row === absolute && editing.column === columnIndex) {
      cell.append(cellEditor(absolute, columnIndex, cell));
    } else {
      const value = effectiveValue(absolute, columnIndex);
      if (value === null) {
        const nullMarker = document.createElement('span');
        nullMarker.className = 'null';
        nullMarker.textContent = 'NULL';
        cell.append(nullMarker);
      } else {
        const text = formatCell(value);
        cell.textContent = text;
        if (text.length > 80) {
          cell.title = t('Double-click to edit, or use Copy value for the whole value');
        }
      }
    }

    row.append(cell);
  }

  return row;
}

/**
 * The input a cell becomes while it is being edited.
 *
 * Every keystroke goes straight into the pending map instead of waiting for a commit. That is what
 * makes editing survive the grid's own re-rendering: a scroll or a page change rebuilds the rows, and
 * the editor is rebuilt from the pending value rather than from a variable that would have been lost.
 * Nothing is sent to the extension until the user asks for the SQL.
 */
function cellEditor(
  absolute: number,
  columnIndex: number,
  cell: HTMLTableCellElement,
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cell-editor';
  input.spellcheck = false;

  const edit = pending.get(editKey(absolute, columnIndex));
  const original = originalValue(absolute, columnIndex);
  input.value = edit ? (edit.isNull ? '' : edit.value) : original === null ? '' : formatCell(original);
  if ((edit && edit.isNull) || (!edit && original === null)) {
    input.placeholder = 'NULL';
    input.title = t('Empty means NULL here; Ctrl+Delete sets NULL again');
  }

  input.addEventListener('input', () => {
    pending.set(editKey(absolute, columnIndex), {
      column: columnIndex,
      value: input.value,
      isNull: false,
    });
    cell.classList.add('dirty');
    // The row number is marked here rather than by re-rendering the rows: a re-render would take the
    // caret with it, and the mark is the only thing that has to change.
    cell.parentElement?.firstElementChild?.classList.add('dirty');
    // Only the toolbar is repainted: re-rendering the grid here would take the caret with it.
    renderToolbar();
  });

  input.addEventListener('keydown', (event) => {
    // The editor owns these keys. Without stopping them here the document-level handler sees the same
    // Enter that committed the edit and immediately opens the editor again.
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      editing = undefined;
      render();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      // Escape puts the cell back to what the query returned, which is the only way to undo an edit
      // without regenerating the result.
      pending.delete(editKey(absolute, columnIndex));
      editing = undefined;
      render();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      const next = columnIndex + (event.shiftKey ? -1 : 1);
      if (next >= 0 && next < state.columns.length) {
        editing = { row: absolute, column: next };
        selection = { anchor: editing, focus: editing };
        render();
      }
      return;
    }
    if (event.key === 'Delete' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      pending.set(editKey(absolute, columnIndex), { column: columnIndex, value: '', isNull: true });
      render();
    }
  });

  // Focus once the input is in the document: an element that is not attached yet cannot take focus.
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
  return input;
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
      text(t('{0} row(s)', state.totalRows.toLocaleString())),
      text(t('{0} column(s)', state.columns.length)),
      text(formatDuration(state.elapsedMillis)),
    );
    if (countedTotal !== undefined) {
      statusBar.append(text(t('{0} row(s) in total', countedTotal.toLocaleString())));
    }
    if (state.truncated) {
      const warning = document.createElement('span');
      warning.className = 'warning';
      warning.textContent = t(
        'Truncated at {0} rows. Export to get everything.',
        (state.truncatedAt ?? 0).toLocaleString(),
      );
      statusBar.append(warning);
    }
    // A failed page fetch lands here: the grid keeps showing the page it has, and this is the only
    // place that says why the next one never arrived.
    if (state.message) {
      const failed = document.createElement('span');
      failed.className = 'warning';
      failed.textContent = state.message;
      statusBar.append(failed);
    }
    if (pending.size > 0) {
      const edits = document.createElement('span');
      edits.className = 'edits';
      edits.textContent = t('{0} cell(s) edited', pending.size.toLocaleString());
      statusBar.append(edits);
    }
    if (identityNames.length > 0) {
      statusBar.append(text(t('Rows identified by {0}', identityNames.join(', '))));
    }
  } else if (state.mode === 'update') {
    statusBar.append(text(state.message ?? ''), text(formatDuration(state.elapsedMillis)));
  } else if (state.mode === 'error') {
    const error = document.createElement('span');
    error.className = 'warning';
    error.textContent = state.errorCode ?? 'ERROR';
    statusBar.append(error);
  }

  if (notice) {
    // Dismissable: a note about generated SQL is worth reading once and then worth getting out of the
    // way, and there is nowhere else in the panel to put it.
    const note = document.createElement('span');
    note.className = 'notice';
    note.textContent = notice;
    note.title = t('Click to dismiss');
    note.addEventListener('click', () => {
      notice = undefined;
      renderStatus();
    });
    statusBar.append(note);
  }

  statusBar.append(spacer());
  if (state.connectionName) {
    statusBar.append(text(state.connectionName));
  }
  if (state.busy) {
    statusBar.append(text(t('Running…')));
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
  const cell = cellOf(event.target as HTMLElement);
  if (!cell) {
    return;
  }
  event.preventDefault();
  beginEdit(cell);
});

table.addEventListener('click', (event) => {
  const cell = cellOf(event.target as HTMLElement);
  if (!cell) {
    return;
  }
  const reference = referenceOf(cell);
  // Shift extends the range from where the user last clicked, which is what makes a block of cells
  // copyable as one piece of text.
  selection = event.shiftKey && selection
    ? { anchor: selection.anchor, focus: reference }
    : { anchor: reference, focus: reference };
  editing = undefined;
  // Only the rows are repainted: a full render would rebuild the toolbar for a click that cannot
  // have changed it.
  renderVisibleRows(true);
});

table.addEventListener('contextmenu', (event) => {
  const cell = cellOf(event.target as HTMLElement);
  if (!cell) {
    return;
  }
  event.preventDefault();
  const reference = referenceOf(cell);
  if (!selection || !isSelected(reference.row, reference.column)) {
    selection = { anchor: reference, focus: reference };
    renderVisibleRows(true);
  }
  showMenu(cellMenuItems(), event.clientX, event.clientY);
});

document.addEventListener('click', (event) => {
  // A click on the toolbar is how its own menu opens; the event that opened it must not also close it.
  const inToolbar = (event.target as HTMLElement).closest('#toolbar') !== null;
  if (contextMenu && !contextMenu.contains(event.target as Node) && !inToolbar) {
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
    if (editing) {
      // The editor handles its own Escape; this covers the case where focus has left it.
      editing = undefined;
      renderVisibleRows(true);
    }
    return;
  }

  // A cell is being typed into: the editor owns the keyboard, and the grid must not also move.
  if (editing) {
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && selection) {
    // Let the browser handle a text selection, but make a selected cell copyable.
    if (!window.getSelection()?.toString()) {
      void copySelection();
    }
    return;
  }

  if (!selection || state.mode !== 'result') {
    return;
  }
  const moves: Record<string, { row: number; column: number }> = {
    ArrowUp: { row: -1, column: 0 },
    ArrowDown: { row: 1, column: 0 },
    ArrowLeft: { row: 0, column: -1 },
    ArrowRight: { row: 0, column: 1 },
  };
  const move = moves[event.key];
  if (move) {
    event.preventDefault();
    const next = {
      row: Math.min(
        Math.max(0, selection.focus.row + move.row),
        Math.max(0, state.totalRows - 1),
      ),
      column: Math.min(
        Math.max(0, selection.focus.column + move.column),
        Math.max(0, state.columns.length - 1),
      ),
    };
    selection = event.shiftKey
      ? { anchor: selection.anchor, focus: next }
      : { anchor: next, focus: next };
    revealRow(next.row);
    renderVisibleRows(true);
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    const cell = cellAt(selection.focus.row, selection.focus.column);
    if (cell) {
      beginEdit(cell);
    }
  }
});

/** The cell element of a click target, or undefined for the gutter and anything outside the grid. */
function cellOf(target: HTMLElement): HTMLTableCellElement | undefined {
  const cell = target.closest('td') as HTMLTableCellElement | null;
  if (!cell || cell.classList.contains('row-number') || cell.querySelector('.cell-editor')) {
    return undefined;
  }
  return cell;
}

/** Where a rendered cell sits in the result as a whole. */
function referenceOf(cell: HTMLTableCellElement): CellRef {
  return {
    row: state.offset + Number(cell.dataset.row),
    column: Number(cell.dataset.column),
  };
}

function cellAt(row: number, column: number): HTMLTableCellElement | undefined {
  const local = row - state.offset;
  if (local < 0) {
    return undefined;
  }
  const found = body.querySelectorAll('tr');
  for (const element of found) {
    const cell = element.children[column + 1] as HTMLTableCellElement | undefined;
    if (cell && Number(cell.dataset.row) === local) {
      return cell;
    }
  }
  return undefined;
}

function beginEdit(cell: HTMLTableCellElement): void {
  const reference = referenceOf(cell);
  selection = { anchor: reference, focus: reference };
  editing = reference;
  renderVisibleRows(true);
}

/** Scrolls a row into view, so arrow keys can walk past the rendered window. */
function revealRow(row: number): void {
  const local = row - state.offset;
  const top = headerHeight + local * ROW_HEIGHT;
  if (top < viewport.scrollTop + headerHeight) {
    viewport.scrollTop = Math.max(0, top - headerHeight - ROW_HEIGHT);
  } else if (top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) {
    viewport.scrollTop = top + ROW_HEIGHT - viewport.clientHeight;
  }
}

function isSelected(row: number, column: number): boolean {
  const bounds = selectionBounds();
  return (
    bounds !== undefined &&
    row >= bounds.firstRow &&
    row <= bounds.lastRow &&
    column >= bounds.firstColumn &&
    column <= bounds.lastColumn
  );
}

function selectionBounds():
  | { firstRow: number; lastRow: number; firstColumn: number; lastColumn: number }
  | undefined {
  if (!selection) {
    return undefined;
  }
  return {
    firstRow: Math.min(selection.anchor.row, selection.focus.row),
    lastRow: Math.max(selection.anchor.row, selection.focus.row),
    firstColumn: Math.min(selection.anchor.column, selection.focus.column),
    lastColumn: Math.max(selection.anchor.column, selection.focus.column),
  };
}

/**
 * Copies the selected block as tab-separated text.
 *
 * Cells the user has edited are copied as they now read, not as the query returned them, because the
 * clipboard is the one place where what is on screen is what should come out.
 */
async function copySelection(): Promise<void> {
  const bounds = selectionBounds();
  if (!bounds) {
    return;
  }
  const lines: string[] = [];
  for (let row = bounds.firstRow; row <= bounds.lastRow; row++) {
    const values: string[] = [];
    for (let column = bounds.firstColumn; column <= bounds.lastColumn; column++) {
      const value = effectiveValue(row, column);
      values.push(value === null ? '' : formatCell(value));
    }
    lines.push(values.join('\t'));
  }
  await copyText(lines.join('\n'));
}

/**
 * What the user is looking at for a cell: the edit if there is one, otherwise the row's own value.
 *
 * Edits are held as text because that is what a text field produces; a column's type is not applied
 * here, which is why a statement written from an edit quotes it unless the column is numeric and the
 * text is genuinely a number.
 */
function effectiveValue(absolute: number, column: number): GridValue {
  const edit = pending.get(editKey(absolute, column));
  if (edit) {
    return edit.isNull ? null : edit.value;
  }
  return originalValue(absolute, column);
}

/** The value the query returned, ignoring any edit. */
function originalValue(absolute: number, column: number): GridValue {
  return state.rows[absolute - state.offset]?.[column] ?? null;
}

function rowIsDirty(absolute: number): boolean {
  for (const key of pending.keys()) {
    if (key.startsWith(`${absolute}|`)) {
      return true;
    }
  }
  return false;
}

/** One entry of the in-panel menu. */
interface MenuItem {
  readonly label: string;
  readonly run: () => void;
  readonly disabled?: boolean;
}

/**
 * The statements the grid can write, and the questions it has to ask first.
 *
 * Nothing here is executed: a statement is put on the clipboard and opened for review. A grid is the
 * wrong place to confirm a write, and the person asking for the SQL usually wants to read it, adjust
 * it, or paste it into a migration.
 */
function sqlMenuItems(): MenuItem[] {
  const rows = selectedRowIndexes();
  return [
    { label: t('Copy as INSERT'), disabled: rows.length === 0, run: () => generateStatement('insert', rows) },
    { label: t('Copy as UPDATE'), disabled: rows.length === 0, run: () => generateStatement('update', rows) },
    { label: t('Copy as DELETE'), disabled: rows.length === 0, run: () => generateStatement('delete', rows) },
    {
      label: t('Copy as SELECT COUNT(*)'),
      // Copied, not run: the statement is wanted for a report or a script far more often than the
      // number is wanted right now, and running it is the toolbar's "Count all rows…".
      run: () => {
        const statement = countStatement(state.sql);
        if (!statement) {
          notice = t('Only a statement that returns rows can be counted.');
          renderStatus();
          return;
        }
        notice = t('Copied the COUNT statement.');
        void copyText(statement);
        renderStatus();
      },
    },
    { label: t('Choose row identity columns…'), run: () => post({ type: 'chooseIdentityColumns' }) },
  ];
}

/** Everything the menu offers on a cell, in the order it is offered. */
function cellMenuItems(): MenuItem[] {
  const bounds = selectionBounds();
  const single =
    bounds !== undefined && bounds.firstRow === bounds.lastRow && bounds.firstColumn === bounds.lastColumn;
  const reference = single && bounds ? { row: bounds.firstRow, column: bounds.firstColumn } : undefined;
  const items: MenuItem[] = [];

  if (reference) {
    items.push(
      {
        label: t('Edit cell'),
        run: () => {
          const cell = cellAt(reference.row, reference.column);
          if (cell) {
            beginEdit(cell);
          }
        },
      },
      {
        label: t('Set NULL'),
        run: () => {
          pending.set(editKey(reference.row, reference.column), {
            column: reference.column,
            value: '',
            isNull: true,
          });
          editing = undefined;
          render();
        },
      },
      {
        label: t('View full value'),
        run: () => showDetail(effectiveValue(reference.row, reference.column)),
      },
      {
        label: t('Copy value'),
        run: () => void copyText(copyableText(effectiveValue(reference.row, reference.column))),
      },
      {
        label: t('Copy column name'),
        run: () => void copyText(state.columns[reference.column]?.label ?? ''),
      },
    );
  }

  items.push(
    { label: t('Copy selection'), run: () => void copySelection() },
    {
      label: t('Copy row'),
      run: () => {
        const row = bounds?.firstRow;
        if (row !== undefined) {
          void copyText(rowToText(row));
        }
      },
    },
    {
      label: t('Copy row as JSON'),
      run: () => {
        const row = bounds?.firstRow;
        if (row !== undefined) {
          void copyText(rowToJson(row));
        }
      },
    },
    {
      label: t('Copy all column names'),
      run: () => void copyText(state.columns.map((column) => column.label).join('\t')),
    },
    ...sqlMenuItems(),
  );
  return items;
}

/**
 * Hands the host the rows to write statements for.
 *
 * INSERT and UPDATE are given different things on purpose. An INSERT of what is on screen is the
 * edited row, so the edits *are* the row. An UPDATE has to name the rows it matches, so the original
 * values travel with the edits rather than merged into them: merging would build a `WHERE` from a
 * value that no row has any more.
 */
function generateStatement(kind: GridStatementKind, rows: readonly number[]): void {
  const payload: GridRowForSql[] = rows.map((absolute) =>
    kind === 'insert'
      ? {
          original: state.columns.map((_, column) => effectiveValue(absolute, column)),
        }
      : {
          original: state.columns.map((_, column) => originalValue(absolute, column)),
          changes: pendingForRow(absolute),
        },
  );
  post({ type: 'generateSql', kind, rows: payload });
}

/** The rows the selection covers, as absolute indexes. */
function selectedRowIndexes(): number[] {
  const bounds = selectionBounds();
  if (!bounds) {
    return [];
  }
  const rows: number[] = [];
  for (let row = bounds.firstRow; row <= bounds.lastRow; row++) {
    rows.push(row);
  }
  return rows;
}

/** The edits made to one row, in column order. */
function pendingForRow(absolute: number): GridCellEdit[] {
  const edits: GridCellEdit[] = [];
  for (const [key, edit] of pending) {
    if (Number(key.slice(0, key.indexOf('|'))) === absolute) {
      edits.push(edit);
    }
  }
  return edits.sort((left, right) => left.column - right.column);
}

/** Places the menu, flipping it when the click is near an edge. */
function showMenu(items: readonly MenuItem[], x: number, y: number): void {
  closeContextMenu();

  contextMenu = document.createElement('div');
  contextMenu.id = 'context-menu';
  for (const item of items) {
    contextMenu.append(
      button(
        item.label,
        () => {
          closeContextMenu();
          item.run();
        },
        { disabled: item.disabled === true },
      ),
    );
  }

  document.body.append(contextMenu);
  const rect = contextMenu.getBoundingClientRect();
  contextMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  contextMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
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
  title.textContent = t('Value');
  header.append(title, spacer(), button(t('Close'), () => closeDetail()));

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
    post({ type: 'report', message: t('Could not copy to the clipboard: {0}', String(error)) });
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

/**
 * The text a copied cell holds.
 *
 * Separate from {@link formatCell} because the two answer different questions: a cell is *displayed*
 * as `NULL`, but copying it has to yield nothing, exactly as "Copy row" already does. Passing the
 * raw {@link GridValue} to the clipboard instead meant a null cell copied the four characters
 * `null`, and an array - which `String()` joins with commas - lost its structure entirely.
 */
function copyableText(value: GridValue): string {
  return value === null ? '' : formatCell(value);
}

/** One row as tab-separated text, with any edits applied: what is on screen is what is copied. */
function rowToText(absolute: number): string {
  return state.columns.map((_, column) => copyableText(effectiveValue(absolute, column))).join('\t');
}

function rowToJson(absolute: number): string {
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
    object[key] = effectiveValue(absolute, index);
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
  onClick: (event: MouseEvent) => void,
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
