import * as vscode from 'vscode';

import { OUTPUT_CHANNEL_NAME } from '../constants';

/**
 * Extension logging, backed by a VS Code {@link vscode.LogOutputChannel}.
 *
 * A log channel (rather than a plain output channel) is used because it gives per-level filtering
 * the user controls from the standard Output panel, and it timestamps lines for free. Bridge stderr
 * is forwarded through here too, so one panel holds everything needed to diagnose a failure.
 *
 * The channel is created lazily. Importing this module must not touch the VS Code API, otherwise
 * unit tests that merely import a module get tangled up in the extension host.
 */
class Logger {
  private channel: vscode.LogOutputChannel | undefined;

  private get sink(): vscode.LogOutputChannel {
    this.channel ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
    return this.channel;
  }

  trace(message: string, ...args: unknown[]): void {
    this.sink.trace(message, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.sink.debug(message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.sink.info(message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.sink.warn(message, ...args);
  }

  error(error: unknown, ...args: unknown[]): void {
    // Accept a bare Error so call sites do not have to stringify throws by hand.
    if (error instanceof Error) {
      this.sink.error(error, ...args);
    } else {
      this.sink.error(String(error), ...args);
    }
  }

  /** Brings the Output panel to the front, for commands that report diagnostics. */
  show(): void {
    this.sink.show(true);
  }

  dispose(): void {
    this.channel?.dispose();
    this.channel = undefined;
  }
}

export const log = new Logger();

/**
 * Renders an unknown thrown value for a user-facing message.
 *
 * TypeScript allows throwing anything, and a rejected promise from a child process surfaces as a
 * plain string often enough that `${error}` alone is not reliable.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
