import { AbortController, type AbortSignal } from 'bare-abort-controller'
import type RPC from 'bare-rpc'

let commandCounter = 0

export function getNextCommandId(): number {
  commandCounter = (commandCounter + 1) % Number.MAX_SAFE_INTEGER
  return commandCounter
}

export function isTerminalChunk<T>(value: T): value is T & { done: true } {
  return typeof value === 'object' && value !== null && 'done' in value && value.done === true
}

export type Wire = ReturnType<RPC.IncomingRequest['createResponseStream']>

/**
 * Opens the response stream of `req`. When the client goes away, bare-rpc
 * destroys a response stream that is still open with the channel or cancel
 * error. No one is left to read that error, and an `error` event without a
 * listener is thrown as an uncaught exception, so it is dropped here.
 */
export function openWire(req: RPC.IncomingRequest): Wire {
  const wire = req.createResponseStream()
  wire.on('error', () => {})
  return wire
}

/** Aborts when the client destroys its end of `wire` (and after a normal end). */
export function signalOnWireClose(wire: {
  on(event: 'close', listener: () => void): unknown
}): AbortSignal {
  const controller = new AbortController()
  wire.on('close', () => controller.abort(undefined))
  return controller.signal
}
