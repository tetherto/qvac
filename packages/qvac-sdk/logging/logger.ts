import { safeTransport } from "./transport";
import { createBaseLogger } from "./base-logger";
import type { Logger, LoggerOptions } from "./types";

function createLogger(namespace: string, options?: LoggerOptions): Logger {
  const safeOptions = options
    ? {
        ...options,
        transports:
          options.transports?.map((t) => safeTransport(t, namespace)) || [],
      }
    : undefined;

  return createBaseLogger(namespace, safeOptions);
}

const loggerCache = new Map<string, Logger>();

export function getLogger(namespace: string, options?: LoggerOptions): Logger {
  if (!options) {
    const cached = loggerCache.get(namespace);
    if (cached) {
      return cached;
    }
  }
  const logger = createLogger(namespace, options);
  if (!options) {
    loggerCache.set(namespace, logger);
  }
  return logger;
}
