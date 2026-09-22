import * as vscode from 'vscode';

import { Config } from '../constants';
import {
  DEFAULT_VARIABLE_PATTERN,
  compilePattern,
  substitute,
  variableNames,
  type SubstitutionResult,
} from '../sql/variables';
import { log } from '../util/logger';

const STORAGE_KEY = 'open-dbclient.variableValues';

/**
 * Remembers the values of the `${NAME}` placeholders found in SQL scripts.
 *
 * Values are workspace-scoped rather than per-file: `${V_DATE}` meaning one thing in one script and
 * something else in the next would be a trap, and the same placeholder in two scripts is almost
 * always meant to be the same value.
 */
export class VariableService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChange = this.emitter.event;

  private values: Map<string, string>;

  private names: readonly string[] = [];

  /** Last unusable pattern that was reported, so the warning is not repeated on every keystroke. */
  private warnedPattern: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    const stored = context.workspaceState.get<Record<string, string>>(STORAGE_KEY);
    this.values = new Map(Object.entries(stored ?? {}));
  }

  /** Names referenced by the document the panel is currently describing. */
  get activeNames(): readonly string[] {
    return this.names;
  }

  get activeCount(): number {
    return this.names.length;
  }

  /**
   * The configured pattern, compiled.
   *
   * An unusable pattern disables substitution entirely rather than throwing, but it is reported once:
   * a typo that silently means "no variables here" is indistinguishable from a script with none.
   */
  pattern(): RegExp | undefined {
    const source = vscode.workspace
      .getConfiguration()
      .get<string>(Config.variablePattern, DEFAULT_VARIABLE_PATTERN);
    const compiled = compilePattern(source);

    if (!compiled && source.trim() !== '' && this.warnedPattern !== source) {
      this.warnedPattern = source;
      void vscode.window.showWarningMessage(
        `The variable pattern '${source}' is not a valid regular expression, so no variables will be substituted.`,
      );
      log.warn(`Ignoring the variable pattern '${source}': it does not compile`);
    }
    return compiled;
  }

  /** The stored value, or an empty string when none was given yet. */
  value(name: string): string {
    return this.values.get(name) ?? '';
  }

  async setValue(name: string, value: string): Promise<void> {
    if (this.value(name) === value) {
      return;
    }
    this.values.set(name, value);
    await this.context.workspaceState.update(STORAGE_KEY, Object.fromEntries(this.values));
    this.emitter.fire();
  }

  /**
   * Re-reads the variables of a document.
   *
   * Fires only when the set of names actually changed: this runs while typing, and repainting the
   * panel on every keystroke would fight the user for focus in the inputs.
   */
  track(document: vscode.TextDocument | undefined): void {
    const names = document ? variableNames(document.getText(), this.pattern()) : [];
    const unchanged =
      names.length === this.names.length && names.every((name, index) => name === this.names[index]);
    if (unchanged) {
      return;
    }
    this.names = names;
    this.emitter.fire();
  }

  /** Substitutes the known values into a statement. */
  resolve(text: string): SubstitutionResult {
    return substitute(text, this.pattern(), this.values);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
