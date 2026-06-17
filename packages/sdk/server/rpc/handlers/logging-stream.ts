import type { LoggingStreamRequest, LoggingStreamResponse } from "@/schemas";
import {
  registerLoggingStream,
  unregisterLoggingStream,
} from "@/server/bare/registry/logging-stream-registry";
import type { LogLevel } from "@qvac/logging";

export async function* handleLoggingStream(
  request: LoggingStreamRequest,
): AsyncGenerator<LoggingStreamResponse> {
  const { id } = request;

  const logQueue: LoggingStreamResponse[] = [];
  let pendingResolve: (() => void) | null = null;

  const streamHandler = (
    level: LogLevel,
    namespace: string,
    message: string,
    sourceId: string,
  ) => {
    const logResponse: LoggingStreamResponse = {
      type: "loggingStream",
      // For the global SDK_ALL_LOG_ID stream `sourceId` is the real origin of the
      // log; for a per-id stream it equals the subscription `id`.
      id: sourceId,
      level: level,
      namespace,
      message,
      timestamp: Date.now(),
    };

    logQueue.push(logResponse);

    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve();
    }
  };

  registerLoggingStream(id, streamHandler);

  try {
    while (true) {
      while (logQueue.length > 0) {
        yield logQueue.shift()!;
      }

      // Wait for new logs - stream will terminate when client disconnects
      await new Promise<void>((resolve) => {
        pendingResolve = resolve;
      });
    }
  } finally {
    unregisterLoggingStream(id, streamHandler);
  }
}
