import * as vscode from 'vscode';

import { describeError, log } from '../util/logger';
import { mergeById, readEntries } from '../util/configMerge';

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
  /** Set on a user copy to remove a bundled entry instead of replacing it. */
  readonly disabled?: boolean;
}

/** Where a user copy of the bundled file is looked for, relative to global storage. */
const USER_TEMPLATE_PATH = ['templates', 'connection-templates.json'];

/** Built-in templates, loaded from the extension's resources. */
export class ConnectionTemplates {
  private constructor(private readonly templates: readonly ConnectionTemplate[]) {}

  /**
   * Reads the bundled template list, plus the user's copy of it if there is one.
   *
   * A missing or malformed file yields whatever could be read rather than an error: templates are a
   * convenience, and the connection form works fine without them because the user can type the URL.
   * The user file is optional and additive, merged by id, so that a new release can add an entry
   * without every user having to update their copy.
   */
  static async load(context: vscode.ExtensionContext): Promise<ConnectionTemplates> {
    const bundled = await readTemplateFile(
      vscode.Uri.joinPath(context.extensionUri, 'resources', ...USER_TEMPLATE_PATH),
      'bundled',
    );
    const user = await readTemplateFile(
      vscode.Uri.joinPath(context.globalStorageUri, ...USER_TEMPLATE_PATH),
      'user',
    );

    const templates = mergeById(bundled, user);
    if (user.length > 0) {
      log.info(
        `Merged ${user.length} user connection template(s) over ${bundled.length} bundled one(s)`,
      );
    }
    return new ConnectionTemplates(templates);
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
    disabled: record.disabled === true ? true : undefined,
  };
}

/**
 * Reads one template file.
 *
 * A file that is not there is not a problem - the bundled one always is, and the user's copy usually
 * is not. Anything else is reported and treated as absent, because a convenience file must never be
 * able to stop the extension from starting.
 */
async function readTemplateFile(uri: vscode.Uri, origin: string): Promise<readonly ConnectionTemplate[]> {
  let raw: Uint8Array;
  try {
    raw = await vscode.workspace.fs.readFile(uri);
  } catch {
    return [];
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    const templates = readEntries(parsed, 'templates')
      .map(toTemplate)
      .filter((template): template is ConnectionTemplate => template !== undefined);
    log.debug(`Read ${templates.length} ${origin} connection template(s)`);
    return templates;
  } catch (error) {
    log.warn(`The ${origin} connection template file could not be parsed: ${describeError(error)}`);
    return [];
  }
}
