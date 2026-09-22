import * as vscode from 'vscode';

import type { QueryHistoryEntry, QueryHistoryStore } from '../service/QueryHistoryStore';

/**
 * A node in the query history view.
 *
 * Carries the whole entry rather than an index, so the commands that act on a node - insert into the
 * editor, delete - do not need to look anything up, and cannot act on the wrong entry if the list
 * has shifted underneath them.
 */
export interface HistoryNode {
  readonly entry: QueryHistoryEntry;
}

/** Lists executed statements, newest first. */
export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly history: QueryHistoryStore) {
    this.subscription = history.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    const { entry } = node;
    // The first line is enough to recognise a statement; the full text is in the tooltip.
    const firstLine = entry.sql.replace(/\s+/g, ' ').trim();
    const label = firstLine.length > 72 ? `${firstLine.slice(0, 72)}…` : firstLine;

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = entry.id;
    item.contextValue = 'history';
    item.iconPath = new vscode.ThemeIcon(
      entry.succeeded ? 'check' : 'error',
      entry.succeeded ? undefined : new vscode.ThemeColor('problemsErrorForeground'),
    );

    const elapsed = entry.elapsedMillis < 1000
      ? `${entry.elapsedMillis} ms`
      : `${(entry.elapsedMillis / 1000).toFixed(2)} s`;
    item.description = `${relativeTime(entry.executedAt)} · ${elapsed}`;

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${escapeMarkdown(entry.connectionName)}** · ${relativeTime(entry.executedAt)}\n\n`);
    if (entry.succeeded) {
      tooltip.appendMarkdown(
        entry.rowCount === undefined ? 'Completed\n\n' : `${entry.rowCount.toLocaleString()} row(s)\n\n`,
      );
    } else {
      tooltip.appendMarkdown(`Failed: ${escapeMarkdown(entry.errorMessage ?? 'unknown error')}\n\n`);
    }
    tooltip.appendCodeblock(entry.sql, 'sql');
    item.tooltip = tooltip;

    return item;
  }

  getChildren(node?: HistoryNode): HistoryNode[] {
    if (node) {
      return [];
    }
    return this.history.list().map((entry) => ({ entry }));
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

/** Renders how long ago something happened, in the form a person would say it. */
function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return `${Math.round(hours / 24)} d ago`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}
