import RPC from 'bare-rpc'
import { AbortController, type AbortSignal } from 'bare-abort-controller'
import { getServerLogger } from '@/logging'

const logger = getServerLogger()

let commandCounter = 0

export function getNextCommandId(): number {
  commandCounter = (commandCounter + 1) % Number.MAX_SAFE_INTEGER
  return commandCounter
}

/**
 * The worker's RPC session. Each incoming request gets a `signal` that aborts
 * when the client cancels the request or the session ends.
 */
export function createWorkerRpc(
  stream: ConstructorParameters<typeof RPC>[0],
  onRequest: (req: RPC.IncomingRequest) => void | Promise<void>
): RPC {
  return new RPC(stream, onRequest, { AbortController })
}

/**
 * Aborts when the client cancels the request or goes away (`req.signal`), or
 * when `responseStream` closes. A client without bare-rpc 2 cancellation, such
 * as one on an older bare-rpc, stops a stream by destroying its end, which
 * closes the stream without a cancel. The stream also closes after a normal
 * end, once the engine has finished with the signal.
 */
export function signalOnCancelOrStreamClose(
  req: { signal: AbortSignal | null },
  responseStream: { on(event: 'close', listener: () => void): unknown }
): AbortSignal {
  const controller = new AbortController()
  const abort = () => controller.abort(undefined)
  if (req.signal?.aborted) abort()
  else req.signal?.addEventListener('abort', abort, { once: true })
  responseStream.on('close', abort)
  return controller.signal
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
