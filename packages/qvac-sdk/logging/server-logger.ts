import { createStreamLogger } from "./stream-logger";
import type { Logger, LoggerOptions } from "./types";
import { SDK_LOG_ID, SDK_SERVER_NAMESPACE } from "./namespaces";

let cachedLogger: Logger | null = null;

export function getServerLogger(options?: LoggerOptions): Logger {
  if (!options && cachedLogger) {
    return cachedLogger;
  }

  const logger = createStreamLogger(SDK_LOG_ID, SDK_SERVER_NAMESPACE, {
    enableConsole: true, // SDK logs should still print to console
    ...options,
  });

  if (!options) {
    cachedLogger = logger;
  }

  return logger;
}
