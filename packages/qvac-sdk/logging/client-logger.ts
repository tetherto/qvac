import { getLogger } from "./logger";
import type { Logger, LoggerOptions } from "./types";

const CLIENT_NAMESPACE = "sdk:client";

let cachedLogger: Logger | null = null;

export function getClientLogger(options?: LoggerOptions): Logger {
  if (!options && cachedLogger) {
    return cachedLogger;
  }

  const logger = getLogger(CLIENT_NAMESPACE, options);

  if (!options) {
    cachedLogger = logger;
  }

  return logger;
}
