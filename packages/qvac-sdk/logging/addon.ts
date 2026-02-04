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

const ADDON_LOGGERS_KEY = Symbol.for("@qvac/sdk:addon-loggers");
const MODEL_LOGGERS_KEY = Symbol.for("@qvac/sdk:model-loggers");

type AddonLoggersMap = Map<string, Set<Logger>>;
type ModelLoggersMap = Map<string, { namespace: string; logger: Logger }>;

function getAddonLoggers(): AddonLoggersMap {
  const global = globalThis as { [ADDON_LOGGERS_KEY]?: AddonLoggersMap };
  if (!global[ADDON_LOGGERS_KEY]) {
    global[ADDON_LOGGERS_KEY] = new Map();
  }
  return global[ADDON_LOGGERS_KEY];
}

function getModelLoggers(): ModelLoggersMap {
  const global = globalThis as { [MODEL_LOGGERS_KEY]?: ModelLoggersMap };
  if (!global[MODEL_LOGGERS_KEY]) {
    global[MODEL_LOGGERS_KEY] = new Map();
  }
  return global[MODEL_LOGGERS_KEY];
}

export function registerAddonLogger(
  modelId: string,
  namespace: string,
  logger: Logger,
) {
  const addonLoggers = getAddonLoggers();
  const modelLoggers = getModelLoggers();

  if (!addonLoggers.has(namespace)) {
    addonLoggers.set(namespace, new Set());
  }
  addonLoggers.get(namespace)!.add(logger);
  modelLoggers.set(modelId, { namespace, logger });
}

export function unregisterAddonLogger(modelId: string) {
  const addonLoggers = getAddonLoggers();
  const modelLoggers = getModelLoggers();

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
    const loggers = getAddonLoggers().get(namespace);
    if (!loggers || loggers.size === 0) return;

    const level = PRIORITY_TO_LEVEL[priority] ?? "debug";
    for (const logger of loggers) {
      routeLog(logger, level, message);
    }
  };
}

export function clearAllAddonLoggers() {
  getAddonLoggers().clear();
  getModelLoggers().clear();
}
