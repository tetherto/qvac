import { safeTransport } from "./transport";
import { createBaseLogger } from "./base-logger";
import type { Logger, LoggerOptions } from "./types";

const LOGGER_CACHE_KEY = Symbol.for("@qvac/sdk:logger-cache");

type LoggerCacheMap = Map<string, Logger>;

function getLoggerCache(): LoggerCacheMap {
  const global = globalThis as { [LOGGER_CACHE_KEY]?: LoggerCacheMap };
  if (!global[LOGGER_CACHE_KEY]) {
    global[LOGGER_CACHE_KEY] = new Map();
  }
  return global[LOGGER_CACHE_KEY];
}

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

export function getLogger(namespace: string, options?: LoggerOptions): Logger {
  const cache = getLoggerCache();

  if (!options) {
    const cached = cache.get(namespace);
    if (cached) {
      return cached;
    }
  }
  const logger = createLogger(namespace, options);
  if (!options) {
    cache.set(namespace, logger);
  }
  return logger;
}
