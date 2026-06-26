/**
 * Logging Stream Registry
 *
 * Manages RPC subscriptions for streaming logs from server to connected clients.
 *
 * Purpose:
 * - Registers client subscriptions to model/SDK log streams
 * - Routes log messages to subscribed clients via RPC
 * - Buffers logs during model loading (before client subscribes)
 * - Manages stream lifecycle (subscribe/unsubscribe)
 *
 */

import type { LogLevel } from "@qvac/logging";
import { SDK_ALL_LOG_ID } from "@/logging/namespaces";

// `sourceId` is the id the log was emitted under (a model id, SDK_LOG_ID, a RAG
// workspace key, …). It usually equals the subscription id, but for the global
// SDK_ALL_LOG_ID stream it carries the real origin so subscribers can tell which
// model/SDK/RAG source produced each line instead of always seeing "__all__".
type StreamHandler = (
  level: LogLevel,
  namespace: string,
  message: string,
  sourceId: string,
) => void;

const loggingStreams = new Map<string, Set<StreamHandler>>();

// Buffering for logs emitted during model loading (before client subscribes)
const MAX_BUFFERED_LOGS_PER_MODEL = 100;
const BUFFER_EXPIRY_MS = 30_000;
const BUFFERING_TIMEOUT_MS = 5_000;

interface BufferedLog {
  level: LogLevel;
  namespace: string;
  message: string;
  sourceId: string;
  timestamp: number;
}

const logBuffer = new Map<string, BufferedLog[]>();
const modelsWithBuffering = new Set<string>();
const bufferingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function clearBufferingTimeout(id: string) {
  const timeout = bufferingTimeouts.get(id);
  if (timeout) {
    clearTimeout(timeout);
    bufferingTimeouts.delete(id);
  }
}

export function startLogBuffering(id: string) {
  modelsWithBuffering.add(id);
}

export function stopLogBufferingWithTimeout(id: string) {
  clearBufferingTimeout(id);
  const timeout = setTimeout(() => {
    if (modelsWithBuffering.has(id)) {
      modelsWithBuffering.delete(id);
      logBuffer.delete(id);
    }
    bufferingTimeouts.delete(id);
  }, BUFFERING_TIMEOUT_MS);

  bufferingTimeouts.set(id, timeout);
}

export function registerLoggingStream(id: string, streamHandler: StreamHandler) {
  if (!loggingStreams.has(id)) {
    loggingStreams.set(id, new Set());
  }
  loggingStreams.get(id)!.add(streamHandler);

  const buffered = logBuffer.get(id);
  if (buffered && buffered.length > 0) {
    for (const log of buffered) {
      try {
        streamHandler(log.level, log.namespace, log.message, log.sourceId);
      } catch (error) {
        console.error(`Error flushing buffered log for ID ${id}:`, error); // fallback (avoid recursion)
      }
    }
    logBuffer.delete(id);
  }

  modelsWithBuffering.delete(id);
  clearBufferingTimeout(id);
}

export function unregisterLoggingStream(
  id: string,
  streamHandler: StreamHandler,
) {
  const streams = loggingStreams.get(id);
  if (streams) {
    streams.delete(streamHandler);
    if (streams.size === 0) {
      loggingStreams.delete(id);
    }
  }
}

export function unregisterAllLoggingStreams(id: string) {
  // Simply remove all logging handlers
  // Active streams will naturally terminate when no more logs flow
  loggingStreams.delete(id);
  logBuffer.delete(id);
  modelsWithBuffering.delete(id);
  clearBufferingTimeout(id);
}

export function sendLogToStreams(
  id: string,
  level: LogLevel,
  namespace: string,
  message: string,
) {
  // The originating id is preserved as `sourceId` so the global stream keeps the
  // real origin of each log instead of reporting the subscription id.
  deliverToStream(id, level, namespace, message, id);
  if (id !== SDK_ALL_LOG_ID) {
    deliverToStream(SDK_ALL_LOG_ID, level, namespace, message, id);
  }
}

function deliverToStream(
  id: string,
  level: LogLevel,
  namespace: string,
  message: string,
  sourceId: string,
) {
  const streams = loggingStreams.get(id);
  const isBuffering = modelsWithBuffering.has(id);

  if (streams && streams.size > 0) {
    for (const streamHandler of streams) {
      try {
        streamHandler(level, namespace, message, sourceId);
      } catch (error) {
        console.error(`Error sending log to stream for ID ${id}:`, error); // fallback (avoid recursion)
      }
    }
  } else if (isBuffering) {
    if (!logBuffer.has(id)) {
      logBuffer.set(id, []);
    }

    const buffer = logBuffer.get(id)!;
    const now = Date.now();

    const validLogs = buffer.filter(
      (log) => now - log.timestamp < BUFFER_EXPIRY_MS,
    );

    if (validLogs.length >= MAX_BUFFERED_LOGS_PER_MODEL) {
      validLogs.shift();
    }

    validLogs.push({ level, namespace, message, sourceId, timestamp: now });
    logBuffer.set(id, validLogs);
  }
}

export function hasLoggingStreams(id: string) {
  const streams = loggingStreams.get(id);
  return streams && streams.size > 0;
}

export function getLoggingStreamStats() {
  return {
    totalIds: loggingStreams.size,
    ids: Array.from(loggingStreams.keys()),
    totalStreams: Array.from(loggingStreams.values()).reduce(
      (sum, streams) => sum + streams.size,
      0,
    ),
    bufferedIds: logBuffer.size,
    idsWithBuffering: modelsWithBuffering.size,
    activeTimeouts: bufferingTimeouts.size,
  };
}

export function clearAllLoggingStreams() {
  for (const timeout of bufferingTimeouts.values()) {
    clearTimeout(timeout);
  }

  loggingStreams.clear();
  logBuffer.clear();
  modelsWithBuffering.clear();
  bufferingTimeouts.clear();
}
