import { LOG_LEVELS } from "./constants";

type LogLevel = "error" | "warn" | "info" | "debug" | "off";

declare interface LoggerInterface {
  /** Log an error message. */
  error: (...args: any[]) => void;
  /** Log a warn message. */
  warn: (...args: any[]) => void;
  /** Log an info message. */
  info: (...args: any[]) => void;
  /** Log a debug message. */
  debug: (...args: any[]) => void;
  /** Optional method to get current level. */
  getLevel?: () => string;
  /** Optional property or method for level. */
  level?: string | (() => string);
}

declare class QvacLogger {
  /** Expose the available log level constants. */
  static LOG_LEVELS: typeof LOG_LEVELS;

  /**
   * Create a new QvacLogger.
   * @param logger Underlying logger implementing LoggerInterface.
   */
  constructor(logger?: LoggerInterface);

  /**
   * Update the current log level.
   * @param newLevel One of the LOG_LEVELS constants.
   */
  setLevel(newLevel: LogLevel): void;

  /**
   * Get the current log level.
   * @returns The active log level.
   */
  getLevel(): LogLevel;

  /** Log an error message if level permits. */
  error(...msgs: any[]): void;
  /** Log a warning message if level permits. */
  warn(...msgs: any[]): void;
  /** Log an informational message if level permits. */
  info(...msgs: any[]): void;
  /** Log a debug message if level permits. */
  debug(...msgs: any[]): void;
}

declare namespace QvacLogger {
  export { QvacLogger as default, LogLevel, LoggerInterface };
}
export = QvacLogger;
