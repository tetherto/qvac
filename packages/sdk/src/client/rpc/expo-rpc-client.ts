import RPC from 'bare-rpc'
import type { IPC as WorkerIPC } from 'bare-stow-host'
import {
  RPCConnectionFailedError,
  WorkerCrashedError,
  WorkerShutdownError
} from '@/utils/errors-client'
import { initializeConfig } from '@/client/init-hooks'
import {
  DEFAULT_WORKER_START_TIMEOUT_MS,
  rejectOnAbort,
  startDeadline,
  WORKER_SHUTDOWN_GRACE_MS,
  workerCrashed,
  workerStartupFailed
} from '@/client/rpc/worker-failure'
import { resolveConfig } from '@/client/config-loader/resolve-config.expo'
import { getClientLogger } from '@/logging'
import { getDeviceInfo } from '@/client/rpc/expo-device-info'
import { getHomeDir } from '@/client/rpc/expo-home-dir'
import type { QvacConfig, RuntimeContext } from '@qvac/inference/surface'

/** The bare-stow harness the Expo plugin copies into the SDK during prebuild. */
interface MobileHarness {
  start(options?: { timeout?: number; grace?: number }): Promise<{ ipc: WorkerIPC }>
}

const logger = getClientLogger()

let rpcInstance: RPC | null = null
let rpcPromise: Promise<RPC> | null = null
let workerIpc: WorkerIPC | null = null
let workerLifeController: AbortController | null = null
let closePromise: Promise<void> | null = null
// Bumped by close(); a start that finishes under an older generation stops its
// own worker, so a caller waiting on that start never receives a closed client.
let generation = 0
let cachedRuntimeContext: RuntimeContext | undefined

logger.debug('EXPO RPC Client bundle')

async function getRuntimeContext(): Promise<RuntimeContext> {
  if (cachedRuntimeContext) {
    return cachedRuntimeContext
  }

  const { platform, deviceModel, deviceBrand } = await getDeviceInfo()

  cachedRuntimeContext = {
    runtime: 'react-native',
    platform,
    deviceModel,
    deviceBrand
  }

  return cachedRuntimeContext
}

function loadHarness(): MobileHarness {
  try {
    return (require('@qvac/sdk/worker.mobile') as { default: MobileHarness }).default
  } catch (error) {
    const message =
      'Failed to load the mobile worker. Make sure the QVAC Expo plugin is configured. ' +
      `Add '@qvac/sdk/expo-plugin' to your app.json plugins array. ` +
      `Error: ${String(error)}`
    logger.error(message)
    throw new RPCConnectionFailedError(message, error)
  }
}

/**
 * The config file, read before the worker starts because it sets the startup
 * timeout. A config that fails to load is reported by `initializeConfig`,
 * which reads it again.
 */
async function readConfigBeforeStart(): Promise<{ config: QvacConfig | undefined } | null> {
  try {
    return { config: await resolveConfig() }
  } catch (error) {
    logger.debug('Reading the config for the worker startup timeout failed; using the default', {
      error
    })
    return null
  }
}

async function startWorker(timeout: number): Promise<WorkerIPC> {
  const harness = loadHarness()
  try {
    return (await harness.start({ timeout, grace: WORKER_SHUTDOWN_GRACE_MS })).ipc
  } catch (error) {
    throw workerStartupFailed(error)
  }
}

export function getWorkerLifeSignal(): AbortSignal | null {
  return workerLifeController?.signal ?? null
}

function dropWorker(reason: Error): WorkerIPC | null {
  const ipc = workerIpc
  const controller = workerLifeController
  workerIpc = null
  workerLifeController = null
  rpcInstance = null
  controller?.abort(reason)
  return ipc
}

/** Stops `ipc` in the background; a start that follows waits for it. */
function stopInBackground(ipc: WorkerIPC) {
  const stopping: Promise<void> = ipc
    .terminate()
    .then(
      () => {},
      () => {}
    )
    .finally(() => {
      if (closePromise === stopping) closePromise = null
    })
  closePromise = stopping
}

export function notifyChannelClosed(): void {
  if (!workerLifeController || workerLifeController.signal.aborted) return
  const closed = dropWorker(new WorkerCrashedError(null, null))
  if (closed) stopInBackground(closed)
}

async function ensureRPC(): Promise<RPC> {
  if (rpcInstance) return rpcInstance
  if (rpcPromise) return rpcPromise
  if (closePromise) {
    await closePromise
    return ensureRPC()
  }

  const startGeneration = generation
  const attempt = (async () => {
    const preloaded = await readConfigBeforeStart()
    if (startGeneration !== generation) throw new WorkerShutdownError()
    const timeout = preloaded?.config?.rpcInitTimeoutMs ?? DEFAULT_WORKER_START_TIMEOUT_MS
    const launchedAt = Date.now()
    const ipc = await startWorker(timeout)
    let workerError: unknown
    let exitCode: number | undefined
    ipc.on('error', (error: unknown) => {
      workerError = error
    })
    ipc.on('exit', (code: number) => {
      exitCode = code
    })
    const crashed = () => workerCrashed(workerError ?? { exitCode })
    if (startGeneration !== generation) {
      await ipc.terminate()
      throw new WorkerShutdownError()
    }
    const controller = new AbortController()
    workerIpc = ipc
    workerLifeController = controller
    logger.info('Worklet started')

    ipc.once('close', () => {
      if (workerIpc !== ipc) return
      logger.info('🪦 Bare worklet closed unexpectedly')
      dropWorker(crashed())
    })

    const rpc = new RPC(ipc, () => {})
    const runtimeContext = await getRuntimeContext()
    const homeDir = await getHomeDir()
    const deadline = startDeadline(timeout - (Date.now() - launchedAt))
    try {
      await Promise.race([
        initializeConfig(
          rpc,
          preloaded ? async () => preloaded.config : resolveConfig,
          runtimeContext,
          homeDir
        ),
        rejectOnAbort(controller.signal),
        deadline.expired
      ])
    } finally {
      deadline.clear()
    }
    if (startGeneration !== generation) throw new WorkerShutdownError()
    if (workerIpc !== ipc) throw crashed()

    rpcInstance = rpc
    return rpc
  })()
  rpcPromise = attempt

  try {
    return await attempt
  } catch (error) {
    logger.error(`Failed to initialize RPC: ${String(error)}`)
    if (startGeneration === generation) {
      const failed = dropWorker(
        error instanceof Error ? error : new WorkerCrashedError(null, null, error)
      )
      if (failed) stopInBackground(failed)
    }
    throw error
  } finally {
    if (rpcPromise === attempt) rpcPromise = null
  }
}

export async function getRPC() {
  return ensureRPC()
}

export async function close(): Promise<void> {
  if (closePromise) return closePromise

  generation++
  closePromise = (async () => {
    const pending = rpcPromise
    rpcPromise = null
    const ipc = dropWorker(new WorkerShutdownError())
    if (!ipc) {
      await pending?.catch(() => {})
      return
    }

    logger.info('🧹 Closing RPC client (Expo)')
    await ipc.terminate()
  })()

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
  // Pre-encode payload — RN/Hermes lacks a global `Buffer`, so `write(string, "utf-8")` would throw.
  requestStream.write(new TextEncoder().encode(payload))
  return { requestStream, responseStream }
}
