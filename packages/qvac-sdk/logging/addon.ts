import type { Logger } from "@/logging";
import type { LogLevel } from "@qvac/logging";
import { unregisterLogger } from "./registry";

// Map C++ addon priority (0-4) to SDK LogLevel
const PRIORITY_TO_LEVEL: Record<number, LogLevel> = {
  0: "error",
  1: "warn",
  2: "info",
  3: "debug",
  4: "debug",
};

// Track ALL loggers per namespace: Map<namespace, Set<Logger>>
const addonLoggers = new Map<string, Set<Logger>>();

// Track modelId → { namespace, logger } for cleanup on unload
const modelLoggers = new Map<string, { namespace: string; logger: Logger }>();

export function registerAddonLogger(
  modelId: string,
  namespace: string,
  logger: Logger,
) {
  if (!addonLoggers.has(namespace)) {
    addonLoggers.set(namespace, new Set());
  }
  addonLoggers.get(namespace)!.add(logger);
  modelLoggers.set(modelId, { namespace, logger });
}

export function unregisterAddonLogger(modelId: string) {
  const entry = modelLoggers.get(modelId);
  if (entry) {
    addonLoggers.get(entry.namespace)?.delete(entry.logger);
    unregisterLogger(entry.logger);
    modelLoggers.delete(modelId);
  }
}

function routeLog(logger: Logger, level: string, message: string) {
  switch (level) {
    case "error":
      logger.error(message);
      break;
    case "warn":
      logger.warn(message);
      break;
    case "info":
      logger.info(message);
      break;
    case "debug":
      logger.debug(message);
      break;
  }
}

export function createAddonLoggerCallback(namespace: string) {
  return (priority: number, message: string) => {
    const loggers = addonLoggers.get(namespace);
    if (!loggers || loggers.size === 0) return;

    const level = PRIORITY_TO_LEVEL[priority] ?? "debug";
    for (const logger of loggers) {
      routeLog(logger, level, message);
    }
  };
}

export function clearAllAddonLoggers() {
  addonLoggers.clear();
  modelLoggers.clear();
}
