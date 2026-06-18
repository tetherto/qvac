import { getLogger } from "./logger";
import type { Logger, LoggerOptions } from "./types";

const CLIENT_NAMESPACE = "sdk:client";
const CLIENT_LOGGER_KEY = Symbol.for("@qvac/sdk:client-logger");

function getCachedClientLogger(): Logger | null {
  const global = globalThis as { [CLIENT_LOGGER_KEY]?: Logger };
  return global[CLIENT_LOGGER_KEY] ?? null;
}

function setCachedClientLogger(logger: Logger): void {
  const global = globalThis as { [CLIENT_LOGGER_KEY]?: Logger };
  global[CLIENT_LOGGER_KEY] = logger;
}

export function getClientLogger(options?: LoggerOptions): Logger {
  if (!options) {
    const cached = getCachedClientLogger();
    if (cached) {
      return cached;
    }
  }

  // The SDK's own logs stay off the console unless the caller opts in.
  const logger = getLogger(CLIENT_NAMESPACE, { enableConsole: false, ...options });

  if (!options) {
    setCachedClientLogger(logger);
  }

  return logger;
}
