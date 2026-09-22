import * as vscode from 'vscode';

import { describeError, log } from '../util/logger';

/**
 * A convenience entry for the connection form.
 *
 * This is data, not code. A template prefills a URL shape and names a driver class, and nothing in
 * the extension branches on which template was used. Adding an entry cannot change behaviour on any
 * other database, which is what keeps the "no dialects" promise intact while still sparing users
 * from memorising JDBC URL syntax.
 */
export interface ConnectionTemplate {
  readonly id: string;
  readonly label: string;
  readonly driverClassName: string;
  readonly jdbcUrlTemplate: string;
  readonly defaultPort?: number;
  readonly note?: string;
}

/** Built-in templates, loaded from the extension's resources. */
export class ConnectionTemplates {
  private constructor(private readonly templates: readonly ConnectionTemplate[]) {}

  /**
   * Reads the bundled template list.
   *
   * A missing or malformed file yields an empty list rather than an error: templates are a
   * convenience, and the connection form works fine without them because the user can type the URL.
   */
  static async load(extensionUri: vscode.Uri): Promise<ConnectionTemplates> {
    const uri = vscode.Uri.joinPath(extensionUri, 'resources', 'templates', 'connection-templates.json');
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as { templates?: unknown };
      const entries = Array.isArray(parsed.templates) ? parsed.templates : [];
      const templates = entries
        .map(toTemplate)
        .filter((template): template is ConnectionTemplate => template !== undefined);
      log.debug(`Loaded ${templates.length} connection template(s)`);
      return new ConnectionTemplates(templates);
    } catch (error) {
      log.warn(`Connection templates could not be read: ${describeError(error)}`);
      return new ConnectionTemplates([]);
    }
  }

  list(): readonly ConnectionTemplate[] {
    return this.templates;
  }

  /** The URL shape suggested for a driver class, if one is known. */
  urlFor(driverClassName: string): string | undefined {
    const template = this.templates.find(
      (candidate) => candidate.driverClassName && candidate.driverClassName === driverClassName,
    );
    const url = template?.jdbcUrlTemplate;
    return url && url.length > 0 ? url : undefined;
  }

  /** A short label for a driver class, used in pickers. */
  labelFor(driverClassName: string): string | undefined {
    return this.templates.find((candidate) => candidate.driverClassName === driverClassName)?.label;
  }
}

function toTemplate(raw: unknown): ConnectionTemplate | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const label = typeof record.label === 'string' ? record.label : '';
  if (!id || !label) {
    return undefined;
  }
  return {
    id,
    label,
    driverClassName: typeof record.driverClassName === 'string' ? record.driverClassName : '',
    jdbcUrlTemplate: typeof record.jdbcUrlTemplate === 'string' ? record.jdbcUrlTemplate : '',
    defaultPort: typeof record.defaultPort === 'number' ? record.defaultPort : undefined,
    note: typeof record.note === 'string' ? record.note : undefined,
  };
}
