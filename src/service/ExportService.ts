import * as vscode from 'vscode';

import { Config } from '../constants';
import { ErrorCodes, Methods } from '../bridge/protocol';
import type { JdbcBridge } from '../bridge/JdbcBridge';
import { describeError, log } from '../util/logger';
import { t } from '../util/i18n';

/** Formats the export can produce. */
export type ExportFormat = 'csv' | 'json' | 'sql' | 'xlsx';

interface FormatChoice {
  readonly format: ExportFormat;
  readonly label: string;
  readonly detail: string;
  readonly extension: string;
}

/**
 * The formats on offer.
 *
 * Built on demand rather than stored in a constant, because the labels are translated and the display
 * language is only known once the extension host has started.
 */
function formatChoices(): FormatChoice[] {
  return [
    { format: 'csv', label: 'CSV', detail: t('Comma-separated, opens in any spreadsheet'), extension: 'csv' },
    { format: 'json', label: 'JSON', detail: t('Array of objects, keeps types'), extension: 'json' },
    { format: 'xlsx', label: 'Excel', detail: t('.xlsx, split across sheets if very large'), extension: 'xlsx' },
    { format: 'sql', label: t('INSERT statements'), detail: t('Portable SQL to load elsewhere'), extension: 'sql' },
  ];
}

/** The separators offered by name; anything else can be typed. */
const NAMED_DELIMITERS: readonly { readonly value: string; readonly label: string }[] = [
  { value: ',', label: 'Comma' },
  { value: ';', label: 'Semicolon' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe' },
];

/**
 * Longest separator accepted.
 *
 * Long enough for the point of this being configurable - `~@~`, `|||`, `#;#` - and short enough that it
 * is still a separator rather than a sentence.
 */
const MAX_DELIMITER_LENGTH = 8;

/** How fields are quoted. Mirrors `CsvExport.Quoting` in the bridge. */
type CsvQuoting = 'minimal' | 'always' | 'never';

interface ExportResult {
  file: string;
  format: string;
  rows: number;
  bytes: number;
  elapsedMillis: number;
  /** Fields the writer left unquoted although they needed quotes; only CSV ever sets it. */
  unquotedFields?: number;
}

/**
 * Saves query results to a file.
 *
 * The file is written by the bridge, not streamed through this process. That is the whole point of
 * the split: a million-row export would be a million-row JSON payload over the protocol if the
 * extension did the writing, and there is no reason to pay that when the rows are already on disk in
 * the bridge.
 */
export class ExportService {
  constructor(private readonly bridge: JdbcBridge) {}

  /**
   * Prompts for a format and destination, then exports.
   *
   * @param source exactly one of `queryId` or `sql` must be set: the first exports a result the user
   *               is looking at, the second runs the statement again and streams the whole result
   * @param suggestedName file name to offer, without an extension
   */
  async exportResult(source: {
    connectionId: string;
    queryId?: string;
    sql?: string;
    suggestedName: string;
    tableName?: string;
  }): Promise<void> {
    if (!source.queryId && !source.sql) {
      void vscode.window.showErrorMessage(t('There is nothing to export.'));
      return;
    }

    const configuration = vscode.workspace.getConfiguration();

    const choice = await vscode.window.showQuickPick(formatChoices(), {
      title: t('Export results'),
      placeHolder: t('Choose a format'),
      matchOnDetail: true,
    });
    if (!choice) {
      return;
    }

    // Asked for rather than taken from the setting alone: the separator is a property of the file being
    // produced (for a European spreadsheet it is the semicolon), so it belongs at the point of export
    // and not only in a settings page the user has to leave the dialog to reach.
    let delimiter = configuration.get<string>(Config.csvDelimiter, ',');
    let quoting = configuration.get<string>(Config.csvQuoting, 'minimal');
    if (choice.format === 'csv') {
      const chosenDelimiter = await chooseCsvDelimiter(delimiter);
      if (chosenDelimiter === undefined) {
        return;
      }
      delimiter = chosenDelimiter;

      const chosenQuoting = await chooseCsvQuoting(quoting);
      if (chosenQuoting === undefined) {
        return;
      }
      quoting = chosenQuoting;
    }

    // Exporting SQL requires a table name for the INSERT statements to target.
    let tableName = source.tableName;
    if (choice.format === 'sql' && !tableName) {
      tableName = await vscode.window.showInputBox({
        title: t('Target table'),
        prompt: t('Table name to use in the INSERT statements'),
        value: source.suggestedName.replace(/[^\w$]+/g, '_').replace(/^_+|_+$/g, '') || 'exported_table',
        validateInput: (value) => (value.trim() ? undefined : t('A table name is required')),
      });
      if (!tableName) {
        return;
      }
    }

    const target = await vscode.window.showSaveDialog({
      title: t('Export results'),
      saveLabel: t('Export'),
      defaultUri: vscode.Uri.file(`${source.suggestedName}.${choice.extension}`),
      filters: { [choice.label]: [choice.extension] },
    });
    if (!target) {
      return;
    }

    const options = {
      delimiter,
      quoting,
      writeBom: configuration.get<boolean>(Config.csvWriteBom, true),
      includeHeader: configuration.get<boolean>(Config.includeHeader, true),
      // The comment is the name the column is documented under, which on many schemas is the Chinese
      // label rather than the physical name. It is what a reader of the exported file needs.
      useColumnRemarks: configuration.get<boolean>(Config.useColumnRemarks, true),
      maxRowsPerSheet: configuration.get<number>(Config.excelMaxRowsPerSheet, 1_048_576),
    };

    // Pulled out so the same request can be issued twice: once against the result the user is looking
    // at, and once against a fresh execution of the statement when that result no longer exists.
    const runExport = (from: { queryId?: string; sql?: string }) =>
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('Exporting to {0}', target.fsPath.split(/[\\/]/).pop() ?? ''),
          cancellable: false,
        },
        () =>
          this.bridge.request<ExportResult>(
            Methods.queryExport,
            {
              connectionId: source.connectionId,
              queryId: from.queryId,
              sql: from.sql,
              format: choice.format,
              filePath: target.fsPath,
              tableName,
              options,
            },
            // Exports are unbounded by design, so there is no sensible deadline.
            { timeoutMs: 0 },
          ),
      );

    try {
      let result: ExportResult;
      try {
        result = await runExport(
          source.queryId ? { queryId: source.queryId } : { sql: source.sql },
        );
      } catch (error) {
        // The bridge drops a cached result once its connection closes or the disk budget is reached,
        // while the result panel can easily outlive that. Re-running the statement is slower but it
        // is what the user asked for, and it is far better than a dead end.
        const missing = (error as { code?: string } | undefined)?.code === ErrorCodes.queryNotFound;
        if (!missing || !source.queryId || !source.sql) {
          throw error;
        }
        log.info(`Result ${source.queryId} is no longer cached; re-running the statement to export it`);
        result = await runExport({ sql: source.sql });
      }

      log.info(
        `Exported ${result.rows} row(s) to ${result.file} (${formatBytes(result.bytes)} in ${result.elapsedMillis} ms)`,
      );

      if (result.unquotedFields && result.unquotedFields > 0) {
        // The write itself was what the user asked for, so it is a warning and not an error - and it is
        // worth one, because the alternative is discovering it when the file is loaded again.
        void vscode.window.showWarningMessage(
          t(
            '{0} field(s) contain the separator, a quote or a line break but were written without quotes, so the file may not read back correctly.',
            result.unquotedFields.toLocaleString(),
          ),
        );
      }

      const open = await vscode.window.showInformationMessage(
        t(
          'Exported {0} row(s) to {1} ({2}).',
          result.rows.toLocaleString(),
          result.file.split(/[\\/]/).pop() ?? '',
          formatBytes(result.bytes),
        ),
        t('Open'),
        t('Reveal'),
      );
      if (open === t('Open')) {
        await vscode.commands.executeCommand('vscode.open', target);
      } else if (open === t('Reveal')) {
        await vscode.commands.executeCommand('revealFileInOS', target);
      }
    } catch (error) {
      log.error(error, 'Export failed');
      void vscode.window.showErrorMessage(t('Export failed: {0}', describeError(error)));
    }
  }
}

/**
 * Asks for the CSV separator, offering the common ones by name and anything else on request.
 *
 * Several characters are allowed, which is the point of asking at all: a file whose data is full of
 * commas, semicolons, tabs and pipes is only safe with a separator none of them can produce, and `~@~`
 * is a common answer to that.
 *
 * @returns the separator, or undefined when the user dismissed the question
 */
async function chooseCsvDelimiter(configured: string): Promise<string | undefined> {
  const custom = t('Other…');

  const picked = await vscode.window.showQuickPick(
    [
      ...NAMED_DELIMITERS.map((entry) => ({
        label: `${t(entry.label)}  ${describeDelimiter(entry.value)}`,
        value: entry.value,
      })),
      { label: custom, value: custom },
    ],
    {
      title: t('CSV separator'),
      placeHolder: t('Current setting: {0}', describeDelimiter(configured)),
    },
  );
  if (!picked) {
    return undefined;
  }
  if (picked.value !== custom) {
    return picked.value;
  }

  const typed = await vscode.window.showInputBox({
    title: t('CSV separator'),
    prompt: t('Any text up to {0} characters, for example ~@~.', MAX_DELIMITER_LENGTH),
    value: configured,
    validateInput: (value) => delimiterProblem(normaliseDelimiter(value)),
  });
  if (typed === undefined) {
    return undefined;
  }
  return normaliseDelimiter(typed);
}

/** Asks how fields should be quoted. */
async function chooseCsvQuoting(configured: string): Promise<CsvQuoting | undefined> {
  const choices: readonly { value: CsvQuoting; label: string; detail: string }[] = [
    {
      value: 'minimal',
      label: t('Only when needed'),
      detail: t('A field is quoted only when it contains the separator, a quote or a line break.'),
    },
    {
      value: 'always',
      label: t('Every field'),
      detail: t('Every value, and the header, is wrapped in quotes.'),
    },
    {
      value: 'never',
      label: t('Never'),
      detail: t('No quotes at all. A value containing the separator will make the file unreadable.'),
    },
  ];

  const picked = await vscode.window.showQuickPick(
    choices.map((choice) => ({
      label: choice.label,
      detail: choice.detail,
      description: choice.value === configured ? t('current setting') : undefined,
      value: choice.value,
    })),
    { title: t('CSV quoting'), placeHolder: t('How should fields be quoted?') },
  );
  return picked?.value;
}

/**
 * Reads the `\t` escape.
 *
 * The one escape worth supporting: a real tab in a text field is invisible, so there is no way to see
 * that it is there, and every settings box in the world accepts this spelling.
 */
function normaliseDelimiter(value: string): string {
  return value === '\\t' ? '\t' : value;
}

/** Renders a separator so a tab is visible rather than invisible. */
function describeDelimiter(value: string): string {
  return value.replace(/\t/g, '\\t');
}

/**
 * What is wrong with a separator, or undefined when it is usable.
 *
 * The same rule the bridge applies, for the same reason: a separator containing a quote or a line break
 * produces a file nobody can parse back, and the bridge rejects it rather than writing one.
 */
function delimiterProblem(value: string): string | undefined {
  if (value === '') {
    return t('A separator is required');
  }
  if ([...value].length > MAX_DELIMITER_LENGTH) {
    return t('Use at most {0} characters.', MAX_DELIMITER_LENGTH);
  }
  return /["\r\n]/.test(value)
    ? t('A separator cannot contain a quote or a line break.')
    : undefined;
}

/** Renders a byte count for display. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Renders a duration for display. */
export function formatDuration(millis: number): string {
  if (millis < 1000) {
    return `${millis} ms`;
  }
  if (millis < 60_000) {
    return `${(millis / 1000).toFixed(2)} s`;
  }
  const minutes = Math.floor(millis / 60_000);
  const seconds = Math.round((millis % 60_000) / 1000);
  return `${minutes} m ${seconds} s`;
}
