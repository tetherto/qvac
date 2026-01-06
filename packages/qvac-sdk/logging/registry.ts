/**
 * Logger Instance Registry (Per-Process)
 *
 * Manages the lifecycle of all Logger instances in the CURRENT PROCESS.
 * Client and server run as separate processes, each with their own registry instance.
 *
 * Purpose:
 * - Tracks all Logger objects in this process (getLogger, createStreamLogger, etc.)
 * - Enables process-wide log level control via setGlobalLogLevel()
 * - Enables process-wide console output control via setGlobalConsoleOutput()
 * - Ensures proper cleanup when loggers are no longer needed
 *
 * Config Integration:
 * - loggerLevel and loggerConsoleOutput from config file apply to both processes
 * - Client applies settings after loading config, server applies during __init_config
 *
 * NOTE: This is separate from server/bare/registry/logging-stream-registry.ts
 * which manages RPC subscriptions for streaming logs to connected clients.
 */

import type { LogLevel } from "@qvac/logging";
import type { Logger } from "./types";

const allLoggers = new Set<Logger>();

export function registerLogger(logger: Logger) {
  allLoggers.add(logger);
}

export function unregisterLogger(logger: Logger) {
  allLoggers.delete(logger);
}

export function setGlobalLogLevel(level: LogLevel) {
  for (const logger of allLoggers) {
    logger.setLevel(level);
  }
}

export function setGlobalConsoleOutput(enabled: boolean) {
  for (const logger of allLoggers) {
    logger.setConsoleOutput(enabled);
  }
}
