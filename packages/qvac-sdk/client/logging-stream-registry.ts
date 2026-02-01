import { type Logger, getClientLogger } from "@/logging";
import { loggingStream } from "./api/logging-stream";
import type { LoggingStreamResponse } from "@/schemas/logging-stream";

const logger = getClientLogger();

const activeStreams = new Map<
  string,
  {
    logger: Logger;
    streamIterator: AsyncGenerator<LoggingStreamResponse>;
  }
>();

export function startLoggingStreamForModel(
  modelId: string,
  modelLogger: Logger,
) {
  if (activeStreams.has(modelId)) {
    logger.warn(`Logging stream already active for model ${modelId}`);
    return;
  }

  const streamIterator = loggingStream({ id: modelId });
  activeStreams.set(modelId, { logger: modelLogger, streamIterator });

  try {
    void (async () => {
      try {
        for await (const logMessage of streamIterator) {
          const logLevel = logMessage.level;
          switch (logLevel) {
            case "error":
              modelLogger.error(
                `[${logMessage.namespace}]`,
                logMessage.message,
              );
              break;
            case "warn":
              modelLogger.warn(`[${logMessage.namespace}]`, logMessage.message);
              break;
            case "info":
              modelLogger.info(`[${logMessage.namespace}]`, logMessage.message);
              break;
            case "debug":
              modelLogger.debug(
                `[${logMessage.namespace}]`,
                logMessage.message,
              );
              break;
            default:
              modelLogger.info(`[${logMessage.namespace}]`, logMessage.message);
          }
        }
      } catch (error) {
        logger.error(`Logging stream error for model ${modelId}:`, error);
      } finally {
        activeStreams.delete(modelId);
      }
    })();
  } catch (error) {
    logger.error(`Failed to start logging stream for model ${modelId}:`, error);
    activeStreams.delete(modelId);
    throw error;
  }
}

export function stopLoggingStreamForModel(modelId: string) {
  const stream = activeStreams.get(modelId);
  if (stream) {
    activeStreams.delete(modelId);
    // Terminate the stream iterator - this will close the RPC connection
    // and the server-side async generator will automatically terminate
    void stream.streamIterator.return(undefined);
    logger.debug(`Stopped logging stream for model ${modelId}`);
  }
}

export function hasActiveStreamForModel(modelId: string): boolean {
  return activeStreams.has(modelId);
}
