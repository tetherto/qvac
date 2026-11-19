import type { AbortableRPCOptions, RPCOptions } from '@qvac/inference/surface'
import { type Logger, getClientLogger } from '@/logging'
import { loggingStream } from './api/logging-stream'
import { bindSession, sessionOf } from './session-registry'

const logger = getClientLogger()

// One stream per caller and model: a session's logger opens its stream as
// that session, so the worker ends it when the session closes, and another
// caller sharing the model keeps its own logger.
const activeStreams = new Map<
  string,
  {
    logger: Logger
    controller: AbortController
  }
>()

function streamKey(modelId: string, options: RPCOptions | undefined): string {
  return `${options?.sessionId ?? ''}\u0000${modelId}`
}

export function startLoggingStreamForModel(
  modelId: string,
  modelLogger: Logger,
  options?: RPCOptions,
  openStream: typeof loggingStream = loggingStream
) {
  const key = streamKey(modelId, options)
  if (activeStreams.has(key)) {
    logger.warn(`Logging stream already active for model ${modelId}`)
    return
  }

  const controller = new AbortController()
  // Only the caller's identity carries over from the load: its timeout and
  // profiling options do not apply to a stream that lives as long as the model.
  const streamOptions: AbortableRPCOptions = { signal: controller.signal }
  if (options?.sessionId !== undefined) {
    streamOptions.sessionId = options.sessionId
    const record = sessionOf(options)
    if (record) bindSession(streamOptions, record)
  }
  const streamIterator = openStream({ id: modelId }, streamOptions)
  const entry = { logger: modelLogger, controller }
  activeStreams.set(key, entry)

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
        // A reload may have replaced this entry.
        if (activeStreams.get(key) === entry) activeStreams.delete(key)
      }
    })()
  } catch (error) {
    logger.error(`Failed to start logging stream for model ${modelId}:`, error)
    activeStreams.delete(key)
    throw error
  }
}

/** Stops the logging stream the caller behind `options` opened for the model. */
export function stopLoggingStreamForModel(modelId: string, options?: RPCOptions) {
  const key = streamKey(modelId, options)
  const stream = activeStreams.get(key)
  if (stream) {
    activeStreams.delete(key)
    // `return()` would wait for a log an unloaded model never sends.
    stream.controller.abort()
    logger.debug(`Stopped logging stream for model ${modelId}`)
  }
}

export function hasActiveStreamForModel(modelId: string, options?: RPCOptions): boolean {
  return activeStreams.has(streamKey(modelId, options))
}
