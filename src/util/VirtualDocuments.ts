import * as vscode from 'vscode';

import { VIRTUAL_DOCUMENT_SCHEME } from '../constants';

/**
 * Serves generated content as read-only editor tabs.
 *
 * Used for DDL and column listings. A real editor tab rather than a webview because these are text
 * the user wants to select, search, compare and copy, and every one of those already works in an
 * editor. The document is regenerated into the same URI each time, so asking for a table's DDL twice
 * refocuses the existing tab instead of accumulating duplicates.
 */
export class VirtualDocumentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  static readonly scheme = VIRTUAL_DOCUMENT_SCHEME;

  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.emitter.event;

  /**
   * Builds a URI whose path ends in the extension for the language wanted.
   *
   * VS Code infers the language from the URI, which is what gives the content syntax highlighting and
   * a sensible default editor mode without any further wiring.
   */
  static uri(path: string, extension: string): vscode.Uri {
    const safe = path.replace(/[\\/:*?"<>|]/g, '_');
    const suffix = extension.startsWith('.') ? extension : `.${extension}`;
    return vscode.Uri.from({ scheme: VirtualDocumentProvider.scheme, path: `/${safe}${suffix}` });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  /** Publishes content and opens it, returning the document. */
  async show(path: string, extension: string, content: string): Promise<vscode.TextDocument> {
    const uri = VirtualDocumentProvider.uri(path, extension);
    const key = uri.toString();

    // Firing the change event first makes an already-open tab refresh rather than show stale content.
    if (this.contents.has(key)) {
      this.emitter.fire(uri);
    }
    this.contents.set(key, content);

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    return document;
  }

  /** Registers this provider with VS Code. */
  register(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(VirtualDocumentProvider.scheme, this);
  }

  dispose(): void {
    this.contents.clear();
    this.emitter.dispose();
  }
}
