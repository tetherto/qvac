import { stream } from "@/client/rpc/rpc-client";
import type {
  LoggingStreamResponse,
  LoggingStreamRequest,
  LoggingParams,
} from "@/schemas/logging-stream";
import { InvalidResponseError } from "@/utils/errors-client";

/**
 * Opens a logging stream to receive real-time logs.
 *
 * @param params - The arguments for the logging stream
 * @param params.id - The unique identifier to stream logs for
 * @returns AsyncGenerator yielding logging stream responses
 * @throws {QvacErrorBase} When the response type is invalid or when the stream fails
 *
 * @example
 * ```typescript
 * // Open a logging stream for a model
 * const logStream = loggingStream({ id: 'my-model-id' });
 *
 * // Or stream SDK server logs
 * const sdkLogs = loggingStream({ id: SDK_LOG_ID });
 *
 * for await (const logMessage of logStream) {
 *   console.log(`[${logMessage.level}] ${logMessage.namespace}: ${logMessage.message}`);
 * }
 * ```
 */
export async function* loggingStream(
  params: LoggingParams,
): AsyncGenerator<LoggingStreamResponse> {
  const request: LoggingStreamRequest = {
    type: "loggingStream",
    ...params,
  };

  const responseStream = stream(request);

  for await (const response of responseStream) {
    if (response.type !== "loggingStream") {
      throw new InvalidResponseError("loggingStream");
    }

    yield response;
  }
}
