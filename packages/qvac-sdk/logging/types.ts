import type { LogLevel } from "@qvac/logging";

export type LogTransport = (
  level: LogLevel,
  namespace: string,
  message: string,
) => void | Promise<void>;

export interface LoggerOptions {
  level?: LogLevel;
  namespace?: string;
  transports?: LogTransport[];
  enableConsole?: boolean;
}

export interface Logger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  setLevel: (level: LogLevel) => void;
  getLevel: () => LogLevel;
  addTransport: (transport: LogTransport) => void;
  setConsoleOutput: (enabled: boolean) => void;
}
