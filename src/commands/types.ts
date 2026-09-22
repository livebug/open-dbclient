import * as vscode from 'vscode';

import type { JdbcBridge } from '../bridge/JdbcBridge';
import type { ConnectionStore } from '../model/ConnectionStore';
import type { DriverManager } from '../driver/DriverManager';
import type { ConnectionService } from '../service/ConnectionService';
import type { ConnectionTemplates } from '../service/ConnectionTemplates';
import type { ExportService } from '../service/ExportService';
import type { MetadataService } from '../service/MetadataService';
import type { SqlEditorBinding } from '../service/SqlEditorBinding';
import type { QueryHistoryStore } from '../service/QueryHistoryStore';
import type { MetadataCache } from '../sql/metadataCache';
import type { DatabaseTreeProvider } from '../tree/DatabaseTreeProvider';
import type { VirtualDocumentProvider } from '../util/VirtualDocuments';

/**
 * Everything the commands need.
 *
 * Collected into one interface and threaded through explicitly rather than pulled from module-level
 * singletons: it makes the dependency graph visible, and it means a command module can be reasoned
 * about without knowing what the rest of the extension happens to have created.
 */
export interface CommandDependencies {
  readonly context: vscode.ExtensionContext;
  readonly extensionUri: vscode.Uri;
  readonly bridge: JdbcBridge;
  readonly store: ConnectionStore;
  readonly connections: ConnectionService;
  readonly metadata: MetadataService;
  readonly drivers: DriverManager;
  readonly exportService: ExportService;
  readonly templates: ConnectionTemplates;
  readonly history: QueryHistoryStore;
  readonly metadataCache: MetadataCache;
  readonly tree: DatabaseTreeProvider;
  readonly binding: SqlEditorBinding;
  readonly virtualDocuments: VirtualDocumentProvider;
}
