import { sendLogToStreams } from "@/server/bare/registry/logging-stream-registry";
import { createBaseLogger } from "./base-logger";
import type { Logger, LoggerOptions } from "./types";

export function createStreamLogger(
  id: string,
  namespace: string,
  options?: LoggerOptions,
): Logger {
  return createBaseLogger(
    namespace,
    {
      enableConsole: false, // Default to disable console output for stream loggers
      ...options,
    },
    {
      onLog: (level, namespace, message) => {
        sendLogToStreams(id, level, namespace, message);
      },
    },
  );
}
