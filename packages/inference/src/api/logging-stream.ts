import { stream } from '@/dispatch'
import type {
  LoggingStreamResponse,
  LoggingStreamRequest,
  LoggingParams
} from '@/schemas/logging-stream'
import type { AbortableRPCOptions } from '@/schemas/index'
import { InvalidResponseError } from '@/errors/index'

/**
 * Opens a logging stream to receive real-time logs.
 *
 * @param params - The arguments for the logging stream
 * @param params.id - The unique identifier to stream logs for
 * @param options - Optional call options
 * @param options.signal - Ends the stream when aborted, without an error, and
 *   releases the subscription at once. Use it to stop the stream from outside
 *   its loop: calling `return()` there waits for the next log, which for an id
 *   that gets no more logs never comes. Breaking out of the loop releases it at
 *   once as well.
 * @returns AsyncGenerator yielding logging stream responses
 * @throws {QvacErrorBase} When the response type is invalid or when the stream fails
 *
 * @example
 * ```typescript
 * // Open a logging stream for a model
 * const logStream = loggingStream({ id: 'my-model-id' });
 *
 * // Or stream the engine's own logs
 * const engineLogs = loggingStream({ id: LOG_ID });
 *
 * for await (const logMessage of logStream) {
 *   console.log(`[${logMessage.level}] ${logMessage.namespace}: ${logMessage.message}`);
 * }
 *
 * // Stop reading from outside the loop (on Bare, AbortController comes from
 * // `bare-abort-controller`)
 * const controller = new AbortController();
 * const modelLogs = loggingStream({ id: 'my-model-id' }, { signal: controller.signal });
 * // later
 * controller.abort();
 * ```
 */
export async function* loggingStream(
  params: LoggingParams,
  options?: AbortableRPCOptions
): AsyncGenerator<LoggingStreamResponse> {
  const request: LoggingStreamRequest = {
    type: 'loggingStream',
    ...params
  }

  const responseStream = stream(request, options)

  for await (const response of responseStream) {
    if (response.type !== 'loggingStream') {
      throw new InvalidResponseError('loggingStream')
    }

    yield response
  }
}
