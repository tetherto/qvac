import type { LogLevel } from "@qvac/logging";

/**
 * Log transport callback signature. Receives the log `level`, namespace
 * scoping the message, and the formatted `message`. May return a promise to
 * allow async backends (e.g., network sinks).
 */
export type LogTransport = (
  level: LogLevel,
  namespace: string,
  message: string,
) => void | Promise<void>;

export interface LoggerOptions {
  /** Minimum log level that will be emitted. */
  level?: LogLevel;
  /** Namespace prefix applied to every message emitted by this logger. */
  namespace?: string;
  /** Additional log transports to receive every emitted message. */
  transports?: LogTransport[];
  /** When `false`, disables the default console transport. */
  enableConsole?: boolean;
}

export interface Logger {
  /** Emits a message at the `error` level. */
  error: (...args: unknown[]) => void;
  /** Emits a message at the `warn` level. */
  warn: (...args: unknown[]) => void;
  /** Emits a message at the `info` level. */
  info: (...args: unknown[]) => void;
  /** Emits a message at the `debug` level. */
  debug: (...args: unknown[]) => void;
  /** Emits a message at the `trace` level. */
  trace: (...args: unknown[]) => void;
  /** Sets the logger's minimum log level. */
  setLevel: (level: LogLevel) => void;
  /** Returns the logger's current minimum log level. */
  getLevel: () => LogLevel;
  /** Registers an additional log transport with this logger. */
  addTransport: (transport: LogTransport) => void;
  /** Enables or disables this logger's default console transport. */
  setConsoleOutput: (enabled: boolean) => void;
}
