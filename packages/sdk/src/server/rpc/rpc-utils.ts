import { AbortController, type AbortSignal } from 'bare-abort-controller'
import type RPC from 'bare-rpc'
import { getServerLogger } from '@/logging'

const logger = getServerLogger()

let commandCounter = 0

export function getNextCommandId(): number {
  commandCounter = (commandCounter + 1) % Number.MAX_SAFE_INTEGER
  return commandCounter
}

export function isTerminalChunk<T>(value: T): value is T & { done: true } {
  return typeof value === 'object' && value !== null && 'done' in value && value.done === true
}

/**
 * When the client goes away, bare-rpc destroys a response stream that is
 * still open with the channel or cancel error. No one is left to read that
 * error, and an `error` event without a listener is thrown as an uncaught
 * exception, so it is logged here instead.
 */
export function createResponseStreamLoggingErrors(req: RPC.IncomingRequest): RPC.OutgoingStream {
  const responseStream = req.createResponseStream()
  responseStream.on('error', (error: unknown) => {
    logger.debug('Response stream closed with an error:', error)
  })
  return responseStream
}

/** Aborts when the client destroys its end of `stream` (and after a normal end). */
export function signalOnStreamClose(stream: {
  on(event: 'close', listener: () => void): unknown
}): AbortSignal {
  const controller = new AbortController()
  stream.on('close', () => controller.abort(undefined))
  return controller.signal
}
