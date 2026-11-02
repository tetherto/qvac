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
 * @param options - Call options
 * @param options.signal - Abort to end the stream and release the subscription
 *   at once, from outside the loop.
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
 * // Stop from outside the loop (on Bare, AbortController is from bare-abort-controller)
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
