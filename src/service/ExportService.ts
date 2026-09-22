import * as vscode from 'vscode';

import { Config } from '../constants';
import { ErrorCodes, Methods } from '../bridge/protocol';
import type { JdbcBridge } from '../bridge/JdbcBridge';
import { describeError, log } from '../util/logger';

/** Formats the export can produce. */
export type ExportFormat = 'csv' | 'json' | 'sql' | 'xlsx';

interface FormatChoice {
  readonly format: ExportFormat;
  readonly label: string;
  readonly detail: string;
  readonly extension: string;
}

const FORMATS: readonly FormatChoice[] = [
  { format: 'csv', label: 'CSV', detail: 'Comma-separated, opens in any spreadsheet', extension: 'csv' },
  { format: 'json', label: 'JSON', detail: 'Array of objects, keeps types', extension: 'json' },
  { format: 'xlsx', label: 'Excel workbook', detail: '.xlsx, split across sheets if very large', extension: 'xlsx' },
  { format: 'sql', label: 'INSERT statements', detail: 'Portable SQL to load elsewhere', extension: 'sql' },
];

interface ExportResult {
  file: string;
  format: string;
  rows: number;
  bytes: number;
  elapsedMillis: number;
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
      void vscode.window.showErrorMessage('There is nothing to export.');
      return;
    }

    const choice = await vscode.window.showQuickPick(FORMATS, {
      title: 'Export results',
      placeHolder: 'Choose a format',
      matchOnDetail: true,
    });
    if (!choice) {
      return;
    }

    // Exporting SQL requires a table name for the INSERT statements to target.
    let tableName = source.tableName;
    if (choice.format === 'sql' && !tableName) {
      tableName = await vscode.window.showInputBox({
        title: 'Target table',
        prompt: 'Table name to use in the INSERT statements',
        value: source.suggestedName.replace(/[^\w$]+/g, '_').replace(/^_+|_+$/g, '') || 'exported_table',
        validateInput: (value) => (value.trim() ? undefined : 'A table name is required'),
      });
      if (!tableName) {
        return;
      }
    }

    const target = await vscode.window.showSaveDialog({
      title: 'Export results',
      saveLabel: 'Export',
      defaultUri: vscode.Uri.file(`${source.suggestedName}.${choice.extension}`),
      filters: { [choice.label]: [choice.extension] },
    });
    if (!target) {
      return;
    }

    const configuration = vscode.workspace.getConfiguration();
    const options = {
      delimiter: configuration.get<string>(Config.csvDelimiter, ','),
      writeBom: configuration.get<boolean>(Config.csvWriteBom, true),
      includeHeader: configuration.get<boolean>(Config.includeHeader, true),
      maxRowsPerSheet: configuration.get<number>(Config.excelMaxRowsPerSheet, 1_048_576),
    };

    // Pulled out so the same request can be issued twice: once against the result the user is looking
    // at, and once against a fresh execution of the statement when that result no longer exists.
    const runExport = (from: { queryId?: string; sql?: string }) =>
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Exporting to ${target.fsPath.split(/[\\/]/).pop()}`,
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

      const open = await vscode.window.showInformationMessage(
        `Exported ${result.rows.toLocaleString()} row(s) to ${result.file.split(/[\\/]/).pop()} (${formatBytes(result.bytes)}).`,
        'Open',
        'Reveal',
      );
      if (open === 'Open') {
        await vscode.commands.executeCommand('vscode.open', target);
      } else if (open === 'Reveal') {
        await vscode.commands.executeCommand('revealFileInOS', target);
      }
    } catch (error) {
      log.error(error, 'Export failed');
      void vscode.window.showErrorMessage(`Export failed: ${describeError(error)}`);
    }
  }
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
