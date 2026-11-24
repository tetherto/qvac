/* global Worker */

import RPC from 'bare-rpc'
import type { RuntimeContext } from '@qvac/inference/surface'
import { initializeConfig } from '@/client/init-hooks'
import { getClientLogger } from '@/logging'
import {
  DEFAULT_WORKER_START_TIMEOUT_MS,
  rejectOnAbort,
  startDeadline,
  WORKER_SHUTDOWN_GRACE_MS
} from '@/client/rpc/worker-failure'
import {
  RPCConnectionFailedError,
  WorkerCrashedError,
  WorkerShutdownError,
  WorkerStartupError
} from '@/utils/errors-client'
import { createWorkerPortStream } from '@/utils/worker-port-stream'
import { sanitizePathComponent } from '@/utils/path-sanitize'

const logger = getClientLogger()
const runtimeContext: RuntimeContext = { runtime: 'browser' }

let rpcInstance: RPC | null = null
let rpcPromise: Promise<RPC> | null = null
let workerInstance: Worker | null = null
let workerLifeController: AbortController | null = null
let closePromise: Promise<void> | null = null
let generation = 0
let controlId = 0

async function resolveConfig() {
  return undefined
}

export function getWorkerLifeSignal(): AbortSignal | null {
  return workerLifeController?.signal ?? null
}

function dropWorker(reason: Error): Worker | null {
  const worker = workerInstance
  const controller = workerLifeController
  workerInstance = null
  workerLifeController = null
  rpcInstance = null
  controller?.abort(reason)
  return worker
}

export function notifyChannelClosed(): void {
  if (!workerLifeController || workerLifeController.signal.aborted) return
  dropWorker(new WorkerCrashedError(null, null))?.terminate()
}

function startWorker(): Worker {
  try {
    return new Worker(new URL('../../../worker.browser.mjs', import.meta.url), {
      type: 'module',
      name: 'qvac'
    })
  } catch (error) {
    throw new RPCConnectionFailedError('Failed to start the QVAC browser worker', error)
  }
}

function workerFailure(event: ErrorEvent | MessageEvent): WorkerCrashedError {
  const cause = 'error' in event ? (event.error ?? event.message) : event.data
  return new WorkerCrashedError(null, null, cause)
}

async function ensureRPC(): Promise<RPC> {
  if (closePromise) {
    await closePromise
    return ensureRPC()
  }
  if (rpcInstance) return rpcInstance
  if (rpcPromise) return rpcPromise

  const startGeneration = generation
  const attempt = (async () => {
    const worker = startWorker()
    const controller = new AbortController()
    workerInstance = worker
    workerLifeController = controller

    const fail = (event: ErrorEvent | MessageEvent) => {
      if (workerInstance !== worker) return
      const reason = workerFailure(event)
      logger.error('QVAC browser worker failed', { error: reason })
      dropWorker(reason)?.terminate()
    }
    worker.addEventListener('error', fail)
    worker.addEventListener('messageerror', fail)

    const rpc = new RPC(createWorkerPortStream(worker), () => {})
    const deadline = startDeadline(DEFAULT_WORKER_START_TIMEOUT_MS)
    try {
      await Promise.race([
        initializeConfig(rpc, resolveConfig, runtimeContext, '/'),
        rejectOnAbort(controller.signal),
        deadline.expired
      ])
    } finally {
      deadline.clear()
    }

    if (startGeneration !== generation) throw new WorkerShutdownError()
    if (workerInstance !== worker) throw new WorkerCrashedError(null, null)
    rpcInstance = rpc
    return rpc
  })()
  rpcPromise = attempt

  try {
    return await attempt
  } catch (error) {
    if (startGeneration === generation) {
      dropWorker(
        error instanceof Error
          ? error
          : new WorkerStartupError(
              'Browser worker initialization failed',
              { exitCode: null, exitSignal: null, timedOut: false },
              error
            )
      )?.terminate()
    }
    throw error
  } finally {
    if (rpcPromise === attempt) rpcPromise = null
  }
}

export async function getRPC() {
  return ensureRPC()
}

interface ControlResponse {
  type: 'qvac:control-result'
  id: number
  error?: string
}

async function sendControl(
  worker: Worker,
  signal: AbortSignal,
  message: Record<string, unknown>,
  timeoutMs: number | null = WORKER_SHUTDOWN_GRACE_MS
): Promise<void> {
  const id = ++controlId

  await new Promise<void>((resolve, reject) => {
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            cleanup()
            reject(new RPCConnectionFailedError('QVAC browser worker control request timed out'))
          }, timeoutMs)
    const onAbort = () => {
      cleanup()
      reject(signal.reason instanceof Error ? signal.reason : new WorkerCrashedError(null, null))
    }
    const onWorkerError = (event: ErrorEvent | MessageEvent) => {
      cleanup()
      reject(workerFailure(event))
    }
    const onMessage = (event: MessageEvent) => {
      const response = event.data as Partial<ControlResponse> | null
      if (response?.type !== 'qvac:control-result' || response.id !== id) return
      cleanup()
      if (response.error) reject(new Error(response.error))
      else resolve()
    }
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onWorkerError)
      worker.removeEventListener('messageerror', onWorkerError)
    }

    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onWorkerError, { once: true })
    worker.addEventListener('messageerror', onWorkerError, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      worker.postMessage({ ...message, id })
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

export async function close(): Promise<void> {
  if (closePromise) return closePromise

  const pending = rpcPromise
  const worker = workerInstance
  const controller = workerLifeController

  if (pending) {
    generation++
    rpcPromise = null
    if (workerInstance === worker) {
      workerInstance = null
      workerLifeController = null
      rpcInstance = null
    }
    controller?.abort(new WorkerShutdownError())

    closePromise = (async () => {
      worker?.terminate()
      await pending.catch(() => {})
    })()
  } else if (!worker || !controller) {
    return
  } else {
    closePromise = (async () => {
      await sendControl(worker, controller.signal, { type: 'qvac:close' }, null)
      if (workerInstance === worker) {
        generation++
        workerInstance = null
        workerLifeController = null
        rpcInstance = null
        controller.abort(new WorkerShutdownError())
      }
      worker.terminate()
    })()
  }

  try {
    await closePromise
  } finally {
    closePromise = null
  }
}

export async function createDuplexSession(payload: string, commandId: number) {
  const rpc = await ensureRPC()
  const req = rpc.request(commandId)
  const requestStream = req.createRequestStream()
  const responseStream = req.createResponseStream({ encoding: 'utf-8' })
  requestStream.on('error', (error: unknown) => responseStream.destroy(error as Error))
  requestStream.write(new TextEncoder().encode(payload))
  return { requestStream, responseStream }
}

/** Makes user-selected browser files available together to model-loading requests. */
export async function mountBrowserFiles(files: readonly File[]): Promise<string[]> {
  const selected = Array.from(files)
  if (selected.length === 0) throw new Error('At least one browser file is required.')
  const names = selected.map((file) => {
    const sanitized = sanitizePathComponent(file.name)
    const name = sanitized.slice(sanitized.lastIndexOf('/') + 1)
    if (!name || name === '.') throw new Error('The browser file name must not be empty.')
    return name
  })
  if (new Set(names).size !== names.length) {
    throw new Error('Browser files mounted together must have unique names.')
  }

  await ensureRPC()
  const worker = workerInstance
  const controller = workerLifeController
  if (!worker || !controller) throw new WorkerCrashedError(null, null)

  const root = `/.qvac/mounted/${crypto.randomUUID()}`
  const paths = names.map((name) => `${root}/${name}`)
  await sendControl(worker, controller.signal, {
    type: 'qvac:mount-files',
    files: selected.map((file, index) => ({ path: paths[index], file }))
  })
  return paths
}

/** Makes one user-selected browser file available to model-loading requests. */
export async function mountBrowserFile(file: File): Promise<string> {
  return (await mountBrowserFiles([file]))[0]!
}
