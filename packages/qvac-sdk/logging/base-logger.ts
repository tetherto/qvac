import QvacLogger, { type LogLevel } from "@qvac/logging";
import { LOG_LEVELS } from "@qvac/logging/constants";
import { isLevelEnabled, formatArg } from "./utils";
import type { Logger, LoggerOptions } from "./types";
import { registerLogger } from "./registry";

export interface LoggerExtensions {
  onLog?: (level: LogLevel, namespace: string, message: string) => void;
}

export function createBaseLogger(
  namespace: string,
  options?: LoggerOptions,
  extensions?: LoggerExtensions,
): Logger {
  const qvacLogger = new QvacLogger(console);

  const initialLevel = options?.level ?? LOG_LEVELS.INFO;
  qvacLogger.setLevel(initialLevel);

  const transports = options?.transports || [];
  let consoleEnabled = options?.enableConsole !== false;

  const log = (level: LogLevel, ...args: unknown[]) => {
    if (!isLevelEnabled(level, qvacLogger.getLevel())) {
      return;
    }

    const message = args.map(formatArg).join(" ");

    // Log to console if enabled
    if (consoleEnabled) {
      switch (level) {
        case LOG_LEVELS.ERROR:
          qvacLogger.error(`[${namespace}]`, ...args);
          break;
        case LOG_LEVELS.WARN:
          qvacLogger.warn(`[${namespace}]`, ...args);
          break;
        case LOG_LEVELS.INFO:
          qvacLogger.info(`[${namespace}]`, ...args);
          break;
        case LOG_LEVELS.DEBUG:
          qvacLogger.debug(`[${namespace}]`, ...args);
          break;
      }
    }

    extensions?.onLog?.(level, namespace, message);

    for (const transport of transports) {
      try {
        const result = transport(level, namespace, message);
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            console.error(`Transport error in ${namespace}:`, error); // fallback (avoid recursion)
          });
        }
      } catch (error: unknown) {
        console.error(`Transport error in ${namespace}:`, error); // fallback (avoid recursion)
      }
    }
  };

  const logger: Logger = {
    error: (...args: unknown[]) => log(LOG_LEVELS.ERROR, ...args),
    warn: (...args: unknown[]) => log(LOG_LEVELS.WARN, ...args),
    info: (...args: unknown[]) => log(LOG_LEVELS.INFO, ...args),
    debug: (...args: unknown[]) => log(LOG_LEVELS.DEBUG, ...args),
    trace: (...args: unknown[]) => log(LOG_LEVELS.DEBUG, ...args),
    setLevel: (level: LogLevel) => qvacLogger.setLevel(level),
    getLevel: (): LogLevel => qvacLogger.getLevel(),
    addTransport: (transport) => {
      transports.push(transport);
    },
    setConsoleOutput: (enabled: boolean) => {
      consoleEnabled = enabled;
    },
  };

  registerLogger(logger);

  return logger;
}
