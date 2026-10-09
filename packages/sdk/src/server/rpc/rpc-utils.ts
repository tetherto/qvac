import { AbortController, type AbortSignal } from 'bare-abort-controller'

let commandCounter = 0

export function getNextCommandId(): number {
  commandCounter = (commandCounter + 1) % Number.MAX_SAFE_INTEGER
  return commandCounter
}

export function isTerminalChunk<T>(value: T): value is T & { done: true } {
  return typeof value === 'object' && value !== null && 'done' in value && value.done === true
}

/**
 * A signal that aborts once the client closes its end of a response stream. A
 * client that aborts its stream destroys its end, and bare-rpc closes this one
 * with it. The stream also closes after it ends, which aborts the signal then.
 */
export function signalOnWireClose(wire: {
  on(event: 'close' | 'error', listener: () => void): unknown
}): AbortSignal {
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('The client closed the stream'))
  wire.on('close', abort)
  wire.on('error', abort)
  return controller.signal
}
