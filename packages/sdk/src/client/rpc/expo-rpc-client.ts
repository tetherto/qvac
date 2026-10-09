import RPC from 'bare-rpc'
import type host from 'bare-stow/host'
import {
  RPCConnectionFailedError,
  RPCInitTimeoutError,
  WorkerShutdownError,
  WorkerStartupError
} from '@/utils/errors-client'
import { initializeConfig } from '@/client/init-hooks'
import { resolveConfig } from '@/client/config-loader/resolve-config.expo'
import { getClientLogger } from '@/logging'
import { getDeviceInfo } from '@/client/rpc/expo-device-info'
import type { RuntimeContext } from '@qvac/inference/surface'
import { resolveRPCInitTimeoutMs } from './init-timeout'

type WorkerIPC = InstanceType<typeof host.IPC>

/** The bare-stow harness the Expo plugin copies into the SDK during prebuild. */
interface MobileHarness {
  start(): Promise<{ ipc: WorkerIPC }>
}

const logger = getClientLogger()

let rpcInstance: RPC | null = null
let rpcPromise: Promise<RPC> | null = null
let workerIpc: WorkerIPC | null = null
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

async function getHomeDir(): Promise<string> {
  const { Paths } = await import('expo-file-system')
  return Paths.document.uri.replace('file://', '')
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

function startWithTimeout(timeoutMs: number): Promise<WorkerIPC> {
  const harness = loadHarness()

  return new Promise((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      reject(new RPCInitTimeoutError(timeoutMs))
    }, timeoutMs)

    harness.start().then(
      ({ ipc }) => {
        if (timedOut) {
          void ipc.terminate()
          return
        }
        clearTimeout(timer)
        resolve(ipc)
      },
      (error: unknown) => {
        clearTimeout(timer)
        if (!timedOut) {
          reject(new WorkerStartupError('Worker failed before signalling ready', error))
        }
      }
    )
  })
}

// No life signal on Expo — `#rpc` interface stub.
export function getWorkerLifeSignal(): AbortSignal | null {
  return null
}

// No life signal on Expo, so the RPC layer never calls this — `#rpc` interface stub.
export function notifyChannelClosed(): void {}

async function ensureRPC(): Promise<RPC> {
  if (rpcInstance) return rpcInstance
  if (rpcPromise) return rpcPromise
  if (closePromise) await closePromise

  const startGeneration = generation
  rpcPromise = (async () => {
    const config = await resolveConfig()
    const ipc = await startWithTimeout(
      resolveRPCInitTimeoutMs({ configValue: config?.rpcInitTimeoutMs ?? undefined })
    )
    if (startGeneration !== generation) {
      await ipc.terminate()
      throw new WorkerShutdownError()
    }
    workerIpc = ipc
    logger.info('Worklet started')

    ipc.once('close', () => {
      if (workerIpc !== ipc) return
      logger.info('🪦 Bare worklet closed unexpectedly')
      workerIpc = null
      rpcInstance = null
    })

    const rpc = new RPC(ipc, () => {})
    await initializeConfig(rpc, async () => config, await getRuntimeContext(), await getHomeDir())
    if (startGeneration !== generation) throw new WorkerShutdownError()

    rpcInstance = rpc
    return rpc
  })()

  try {
    return await rpcPromise
  } catch (error) {
    logger.error(`Failed to initialize RPC: ${String(error)}`)
    const ipc = workerIpc
    workerIpc = null
    void ipc?.terminate()
    throw error
  } finally {
    rpcPromise = null
  }
}

export async function getRPC() {
  return ensureRPC()
}

export async function close(): Promise<void> {
  if (closePromise) return closePromise

  generation++
  closePromise = (async () => {
    const ipc = workerIpc
    rpcInstance = null
    workerIpc = null
    if (!ipc) {
      await rpcPromise?.catch(() => {})
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
