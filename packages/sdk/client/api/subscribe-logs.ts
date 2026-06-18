import { getClientLogger, SDK_ALL_LOG_ID } from "@/logging";
import { loggingStream } from "./logging-stream";
import type { LoggingStreamResponse } from "@/schemas/logging-stream";

const logger = getClientLogger();

export type ServerLogHandler = (log: LoggingStreamResponse) => void;

/**
 * Subscribes to every server-side log through a single stream: SDK server logs,
 * per-model addon logs (llamacpp, whispercpp, …) for all loaded models, and RAG
 * logs — without having to open a {@link loggingStream} per id.
 *
 * Each delivered log keeps its origin in `log.id`: `SDK_LOG_ID` for SDK server
 * logs, the model id for model logs, or the RAG workspace key. Use it to tell the
 * sources apart.
 *
 * Internally this opens a {@link loggingStream} on the reserved `SDK_ALL_LOG_ID`
 * stream that the worker fans every log into.
 *
 * @param handler - called once per log line.
 * @returns a function that stops the subscription.
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
  const streamIterator = loggingStream({ id: SDK_ALL_LOG_ID });

  void (async () => {
    try {
      for await (const log of streamIterator) {
        handler(log);
      }
    } catch (error) {
      logger.error("Server log stream error:", error);
    }
  })();

  return () => {
    void streamIterator.return(undefined);
  };
}
