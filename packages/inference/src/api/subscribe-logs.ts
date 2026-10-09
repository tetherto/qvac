import { AbortController } from 'bare-abort-controller'
import { getAppLogger, ALL_LOG_ID } from '@/logging/index'
import { loggingStream } from '@/api/logging-stream'
import type { LoggingStreamResponse } from '@/schemas/logging-stream'

const logger = getAppLogger()

export type ServerLogHandler = (log: LoggingStreamResponse) => void

/**
 * Subscribes to every log through a single stream: the engine's own logs, per-model
 * addon logs (llamacpp, whispercpp, …) for all loaded models, and RAG logs —
 * without having to open a {@link loggingStream} per id.
 *
 * Each delivered log keeps its origin in `log.id`: `LOG_ID` for the engine's own
 * logs, the model id for model logs, or the RAG workspace key. Use it to tell the
 * sources apart.
 *
 * Internally this opens a {@link loggingStream} on the reserved `ALL_LOG_ID`
 * stream that the engine fans every log into.
 *
 * @param handler - called once per log line.
 * @returns a function that stops the subscription at once, without waiting for
 *   another log.
 *
 * @example
 * ```typescript
 * const unsubscribe = subscribeServerLogs((log) => {
 *   console.log(`[${log.level}] ${log.id} ${log.namespace}: ${log.message}`);
 * });
 * // later
 * unsubscribe();
 * ```
 */
export function subscribeServerLogs(handler: ServerLogHandler) {
  const controller = new AbortController()
  const streamIterator = loggingStream({ id: ALL_LOG_ID }, { signal: controller.signal })

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
    controller.abort(new Error('Unsubscribed from server logs'))
  }
}
