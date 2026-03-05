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

const loggingStreams = new Map<
  string,
  Set<(level: LogLevel, namespace: string, message: string) => void>
>();

// Buffering for logs emitted during model loading (before client subscribes)
const MAX_BUFFERED_LOGS_PER_MODEL = 100;
const BUFFER_EXPIRY_MS = 30_000;
const BUFFERING_TIMEOUT_MS = 5_000;

interface BufferedLog {
  level: LogLevel;
  namespace: string;
  message: string;
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

export function registerLoggingStream(
  id: string,
  streamHandler: (level: LogLevel, namespace: string, message: string) => void,
) {
  if (!loggingStreams.has(id)) {
    loggingStreams.set(id, new Set());
  }
  loggingStreams.get(id)!.add(streamHandler);

  const buffered = logBuffer.get(id);
  if (buffered && buffered.length > 0) {
    for (const log of buffered) {
      try {
        streamHandler(log.level, log.namespace, log.message);
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
  streamHandler: (level: LogLevel, namespace: string, message: string) => void,
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
  const streams = loggingStreams.get(id);
  const isBuffering = modelsWithBuffering.has(id);

  if (streams && streams.size > 0) {
    for (const streamHandler of streams) {
      try {
        streamHandler(level, namespace, message);
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

    validLogs.push({ level, namespace, message, timestamp: now });
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
  const count = loggingStreams.size;

  for (const timeout of bufferingTimeouts.values()) {
    clearTimeout(timeout);
  }

  loggingStreams.clear();
  logBuffer.clear();
  modelsWithBuffering.clear();
  bufferingTimeouts.clear();

  if (count > 0) {
    console.log(`🧹 Cleared logging streams for ${count} ID(s)`); // fallback (avoid recursion)
  }
}
