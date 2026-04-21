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

/**
 * Creates or retrieves a cached logger instance for the given namespace.
 *
 * When `options` is omitted, the logger is cached by namespace and subsequent
 * calls with the same namespace return the same instance. When `options` is
 * provided, a new logger is always created.
 *
 * @param namespace - Logger namespace (used for identification and filtering)
 * @param options - Optional logger configuration
 * @returns A logger instance.
 *
 * @example
 * ```typescript
 * import { getLogger } from "@qvac/sdk";
 *
 * const logger = getLogger("my-app");
 *
 * logger.info("Application started");
 * logger.debug("Debug details:", { key: "value" });
 *
 * logger.setLevel("error");
 * logger.info("This will not be logged");
 *
 * const verboseLogger = getLogger("my-app:verbose", {
 *   level: "debug",
 *   enableConsole: true,
 *   transports: [(level, namespace, message) => {
 *     // Custom transport: write to file, send to server, etc.
 *   }],
 * });
 * ```
 */
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
