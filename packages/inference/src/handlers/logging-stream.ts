import type { LoggingStreamRequest, LoggingStreamResponse } from '@/schemas/index'
import type { StreamHandlerContext } from '@/handlers/types'
import { registerLoggingStream, unregisterLoggingStream } from '@/runtime/logging-stream-registry'
import { isOwnerSession, isSessionOpen, onSessionClose } from '@/runtime/session-registry'
import { resolveSessionId } from '@/runtime/session-id'
import type { LogLevel } from '@qvac/logging'

export async function* handleLoggingStream(
  request: LoggingStreamRequest,
  context: StreamHandlerContext = {}
): AsyncGenerator<LoggingStreamResponse> {
  const { id } = request
  const { signal } = context
  if (signal?.aborted) return
  // A subscription is not a registered request, so the session close that
  // drains requests would not reach it; it ends on its own close listener.
  const sessionId = resolveSessionId(request)
  const scoped = !isOwnerSession(sessionId)
  if (scoped && !isSessionOpen(sessionId)) return
  let stopped = false

  const logQueue: LoggingStreamResponse[] = []
  let pendingResolve: (() => void) | null = null

  const wake = () => {
    if (pendingResolve) {
      const resolve = pendingResolve
      pendingResolve = null
      resolve()
    }
  }

  const streamHandler = (level: LogLevel, namespace: string, message: string, sourceId: string) => {
    const logResponse: LoggingStreamResponse = {
      type: 'loggingStream',
      // For the global ALL_LOG_ID stream `sourceId` is the real origin of the
      // log; for a per-id stream it equals the subscription `id`.
      id: sourceId,
      level: level,
      namespace,
      message,
      timestamp: Date.now()
    }

    logQueue.push(logResponse)
    wake()
  }

  // Release at once, even if nobody is reading; a quiet id would wait forever.
  const stop = () => {
    stopped = true
    unregisterLoggingStream(id, streamHandler)
    logQueue.length = 0
    wake()
  }

  registerLoggingStream(id, streamHandler)
  signal?.addEventListener('abort', stop, { once: true })
  const removeCloseListener = scoped ? onSessionClose(sessionId, stop) : undefined

  try {
    while (true) {
      while (logQueue.length > 0) {
        yield logQueue.shift()!
      }

      // Stopped during a read: nothing to wake, so end here.
      if (stopped || signal?.aborted) return

      await new Promise<void>((resolve) => {
        pendingResolve = resolve
      })
    }
  } finally {
    signal?.removeEventListener('abort', stop)
    removeCloseListener?.()
    unregisterLoggingStream(id, streamHandler)
  }
}
