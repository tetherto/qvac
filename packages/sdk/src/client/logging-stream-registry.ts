import { type Logger, getClientLogger } from '@/logging'
import { loggingStream } from './api/logging-stream'

const logger = getClientLogger()

const activeStreams = new Map<
  string,
  {
    logger: Logger
    controller: AbortController
  }
>()

export function startLoggingStreamForModel(modelId: string, modelLogger: Logger) {
  if (activeStreams.has(modelId)) {
    logger.warn(`Logging stream already active for model ${modelId}`)
    return
  }

  const controller = new AbortController()
  const streamIterator = loggingStream({ id: modelId }, { signal: controller.signal })
  const entry = { logger: modelLogger, controller }
  activeStreams.set(modelId, entry)

  try {
    void (async () => {
      try {
        for await (const logMessage of streamIterator) {
          const logLevel = logMessage.level
          switch (logLevel) {
            case 'error':
              modelLogger.error(`[${logMessage.namespace}]`, logMessage.message)
              break
            case 'warn':
              modelLogger.warn(`[${logMessage.namespace}]`, logMessage.message)
              break
            case 'info':
              modelLogger.info(`[${logMessage.namespace}]`, logMessage.message)
              break
            case 'debug':
              modelLogger.debug(`[${logMessage.namespace}]`, logMessage.message)
              break
            default:
              modelLogger.info(`[${logMessage.namespace}]`, logMessage.message)
          }
        }
      } catch (error) {
        logger.error(`Logging stream error for model ${modelId}:`, error)
      } finally {
        // A reload under the same id may have registered a new stream by now.
        if (activeStreams.get(modelId) === entry) activeStreams.delete(modelId)
      }
    })()
  } catch (error) {
    logger.error(`Failed to start logging stream for model ${modelId}:`, error)
    activeStreams.delete(modelId)
    throw error
  }
}

export function stopLoggingStreamForModel(modelId: string) {
  const stream = activeStreams.get(modelId)
  if (stream) {
    activeStreams.delete(modelId)
    // Abort rather than `return()`: an unloaded model logs nothing more, and
    // `return()` waits for the next log before the stream ends.
    stream.controller.abort()
    logger.debug(`Stopped logging stream for model ${modelId}`)
  }
}

export function hasActiveStreamForModel(modelId: string): boolean {
  return activeStreams.has(modelId)
}
