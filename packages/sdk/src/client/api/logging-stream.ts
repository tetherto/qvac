import { stream } from '@/client/rpc/rpc-client'
import type {
  LoggingStreamResponse,
  LoggingStreamRequest,
  LoggingParams,
  AbortableRPCOptions
} from '@qvac/inference/surface'
import { InvalidResponseError } from '@/utils/errors-client'

/**
 * Opens a logging stream to receive real-time logs.
 *
 * @throws {QvacErrorBase} When the response type is invalid or when the stream fails
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
