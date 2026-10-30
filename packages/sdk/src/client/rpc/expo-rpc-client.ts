import RPC from 'bare-rpc'
import type host from 'bare-stow/host'
import {
  RPCConnectionFailedError,
  WorkerCrashedError,
  WorkerShutdownError
} from '@/utils/errors-client'
import { initializeConfig } from '@/client/init-hooks'
import { workerStartupFailed } from '@/client/rpc/worker-failure'
import { resolveConfig } from '@/client/config-loader/resolve-config.expo'
import { getClientLogger } from '@/logging'
import { getDeviceInfo } from '@/client/rpc/expo-device-info'
import { getHomeDir } from '@/client/rpc/expo-home-dir'
import type { RuntimeContext } from '@qvac/inference/surface'

type WorkerIPC = InstanceType<typeof host.IPC>

/** The bare-stow harness the Expo plugin copies into the SDK during prebuild. */
interface MobileHarness {
  start(options?: { timeout?: number }): Promise<{ ipc: WorkerIPC }>
}

const logger = getClientLogger()

const WORKER_READY_TIMEOUT_MS = 60_000

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

async function startWorker(): Promise<WorkerIPC> {
  const harness = loadHarness()
  const started = Date.now()
  try {
    return (await harness.start({ timeout: WORKER_READY_TIMEOUT_MS })).ipc
  } catch (error) {
    throw workerStartupFailed(error, Date.now() - started >= WORKER_READY_TIMEOUT_MS)
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

export function notifyChannelClosed(): void {
  if (!workerLifeController || workerLifeController.signal.aborted) return
  void dropWorker(new WorkerCrashedError(null, null))?.terminate()
}

async function ensureRPC(): Promise<RPC> {
  if (rpcInstance) return rpcInstance
  if (rpcPromise) return rpcPromise
  if (closePromise) await closePromise

  const startGeneration = generation
  const attempt = (async () => {
    const ipc = await startWorker()
    let workerError: unknown
    ipc.on('error', (error: unknown) => {
      workerError = error
    })
    if (startGeneration !== generation) {
      await ipc.terminate()
      throw new WorkerShutdownError()
    }
    workerIpc = ipc
    workerLifeController = new AbortController()
    logger.info('Worklet started')

    ipc.once('close', () => {
      if (workerIpc !== ipc) return
      logger.info('🪦 Bare worklet closed unexpectedly')
      dropWorker(new WorkerCrashedError(null, null, workerError))
    })

    const rpc = new RPC(ipc, () => {})
    await initializeConfig(rpc, resolveConfig, await getRuntimeContext(), await getHomeDir())
    if (startGeneration !== generation) throw new WorkerShutdownError()
    if (workerIpc !== ipc) throw new WorkerCrashedError(null, null, workerError)

    rpcInstance = rpc
    return rpc
  })()
  rpcPromise = attempt

  try {
    return await attempt
  } catch (error) {
    logger.error(`Failed to initialize RPC: ${String(error)}`)
    if (startGeneration === generation) {
      void dropWorker(
        error instanceof Error ? error : new WorkerCrashedError(null, null, error)
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

export async function close(): Promise<void> {
  if (closePromise) return closePromise

  generation++
  closePromise = (async () => {
    const ipc = dropWorker(new WorkerShutdownError())
    if (!ipc) {
      const pending = rpcPromise
      rpcPromise = null
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
