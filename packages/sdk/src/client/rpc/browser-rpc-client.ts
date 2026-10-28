import RPC from 'bare-rpc'
import { RPCConnectionFailedError, RPCInitTimeoutError } from '@/utils/errors-client'
import { initializeConfig } from '@/client/init-hooks'
import { getClientLogger } from '@/logging'
import { sendShutdownMessage } from '@/client/rpc/shutdown-message'
import { DEFAULT_RPC_INIT_TIMEOUT_MS } from '@/client/rpc/init-timeout'
import { createWorkerPortStream } from '@/utils/worker-port-stream'
import type { RuntimeContext } from '@qvac/inference/surface'

const logger = getClientLogger()

let rpcInstance: RPC | null = null
let rpcPromise: Promise<RPC> | null = null
let workerInstance: Worker | null = null
// Aborted when the current worker fails or is torn down; the RPC layer races
// in-flight calls against it, as it does with the Node child's exit.
let workerLifeController: AbortController | null = null
// Set while close() is in flight so concurrent callers share it.
let closingPromise: Promise<void> | null = null

const runtimeContext: RuntimeContext = { runtime: 'browser' }

// The browser has no config file; the worker runs with the SDK defaults.
async function resolveConfig() {
  return undefined
}

export function getWorkerLifeSignal(): AbortSignal | null {
  return workerLifeController?.signal ?? null
}

/** Terminates the current worker and aborts its life signal. */
function teardown(reason: Error): void {
  const worker = workerInstance
  const controller = workerLifeController
  rpcInstance = null
  workerInstance = null
  workerLifeController = null
  worker?.terminate()
  if (controller && !controller.signal.aborted) controller.abort(reason)
}

// The RPC layer saw the channel close under an in-flight call: drop this
// worker so the next call starts a new one.
export function notifyChannelClosed(): void {
  if (!workerLifeController || workerLifeController.signal.aborted) return
  teardown(new RPCConnectionFailedError('QVAC browser worker channel closed'))
}

function startWorker(): Worker {
  try {
    // Bundlers that understand `new Worker(new URL(..., import.meta.url))`
    // (Vite, webpack, Parcel) emit the prebuilt worker as its own chunk.
    // lunte-disable-next-line no-undef -- browser global; this module only runs in a page
    return new Worker(new URL('../../../worker.browser.js', import.meta.url), {
      type: 'module',
      name: 'qvac'
    })
  } catch (error) {
    throw new RPCConnectionFailedError(
      `Failed to start the QVAC browser worker (@qvac/sdk/worker.browser): ${String(error)}`,
      error
    )
  }
}

/** Rejects when @p signal aborts or @p timeoutMs elapses, whichever is first. */
function failure(
  signal: AbortSignal,
  timeoutMs: number
): { promise: Promise<never>; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason as Error)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => reject(new RPCInitTimeoutError(timeoutMs)), timeoutMs)
  })
  return {
    promise,
    clear() {
      clearTimeout(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
}

export async function getRPC() {
  if (rpcInstance) {
    return rpcInstance
  }

  if (rpcPromise) {
    return rpcPromise
  }

  rpcPromise = (async () => {
    const worker = startWorker()
    const controller = new AbortController()
    workerInstance = worker
    workerLifeController = controller
    // A worker that fails to load or throws during startup reports it here;
    // without this the handshake would wait forever.
    worker.addEventListener('error', (event) => {
      const message = event.message || 'failed to load or crashed'
      logger.error(`QVAC browser worker error: ${message}`)
      if (workerLifeController === controller) {
        teardown(new RPCConnectionFailedError(`QVAC browser worker error: ${message}`))
      }
    })
    logger.info('Browser worker started')

    const rpc = new RPC(createWorkerPortStream(worker), () => {})
    const failed = failure(controller.signal, DEFAULT_RPC_INIT_TIMEOUT_MS)
    try {
      await Promise.race([initializeConfig(rpc, resolveConfig, runtimeContext), failed.promise])
    } finally {
      failed.clear()
    }
    rpcInstance = rpc
    return rpc
  })()

  try {
    return await rpcPromise
  } catch (error) {
    logger.error(`Failed to initialize RPC: ${String(error)}`)
    teardown(error instanceof Error ? error : new Error(String(error)))
    throw error
  } finally {
    rpcPromise = null
  }
}

export async function close(): Promise<void> {
  if (closingPromise) return closingPromise

  closingPromise = (async () => {
    logger.info('🧹 Closing RPC client (browser)')
    if (rpcInstance) {
      await sendShutdownMessage(rpcInstance)
    }
    rpcPromise = null
    teardown(new RPCConnectionFailedError('QVAC browser worker closed'))
  })()

  try {
    await closingPromise
  } finally {
    closingPromise = null
  }
}

export async function createDuplexSession(payload: string, commandId: number) {
  const rpc = await getRPC()
  const req = rpc.request(commandId)
  const requestStream = req.createRequestStream()
  const responseStream = req.createResponseStream({ encoding: 'utf-8' })
  requestStream.write(new TextEncoder().encode(payload))
  return { requestStream, responseStream }
}
