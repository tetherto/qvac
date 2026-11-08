import { getClientLogger, SDK_ALL_LOG_ID } from '@/logging'
import { loggingStream } from './logging-stream'
import type { LoggingStreamResponse } from '@qvac/inference/surface'

const logger = getClientLogger()

export type ServerLogHandler = (log: LoggingStreamResponse) => void

/**
 * Subscribes to every server-side log through a single stream: SDK server logs,
 * per-model addon logs (llamacpp, whispercpp, …) for all loaded models, and RAG
 * logs — without having to open a {@link loggingStream} per id.
 */
export function subscribeServerLogs(handler: ServerLogHandler) {
  const controller = new AbortController()
  const streamIterator = loggingStream({ id: SDK_ALL_LOG_ID }, { signal: controller.signal })

  void (async () => {
    try {
      for await (const log of streamIterator) {
        handler(log)
      }
    } catch (error) {
      logger.error('Server log stream error:', error)
    }
  })()

  return () => {
    controller.abort()
  }
}
