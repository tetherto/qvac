import RPC from 'bare-rpc'
import host from 'bare-stow/host'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { initializeConfig } from '@/client/init-hooks'
import { resolveConfig } from '@/client/config-loader/resolve-config.node'
import { getClientLogger } from '@/logging'
import {
  RPCInitTimeoutError,
  WorkerCrashedError,
  WorkerShutdownError,
  WorkerStartupError
} from '@/utils/errors-client'
import type { QvacConfig, RuntimeContext } from '@qvac/inference/surface'
import { RPC_INIT_TIMEOUT_ENV_VAR, resolveRPCInitTimeoutMs } from './init-timeout'

type WorkerIPC = InstanceType<typeof host.IPC>

/** A folder written by `bundleSdk` for `bare-sidecar`, or a worker entry run unbundled. */
type WorkerSource = { harness: string } | { entry: string }

const logger = getClientLogger()

const STOWED_HARNESS = 'index.mjs'
const STOWED_BUNDLE = 'index.bundle'

let rpcInstance: RPC | null = null
let rpcPromise: Promise<RPC> | null = null
let workerIpc: WorkerIPC | null = null
let closePromise: Promise<void> | null = null
// Bumped by close(); a start that finishes under an older generation stops its
// own worker, so a caller waiting on that start never receives a closed client.
let generation = 0
// Aborted when the worker dies (crash) or close() runs (planned). Unblocks
// in-flight `req.reply()` callers: bare-rpc does not reject outgoing requests
// when its stream closes.
let workerLifeController: AbortController | null = null

function findProjectRootSync(): string | undefined {
  let dir = process.cwd()
  const root = path.parse(dir).root

  while (dir !== root) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }

  return undefined
}

function stowedHarness(dir: string): string | undefined {
  const harness = path.join(dir, STOWED_HARNESS)
  return fs.existsSync(harness) && fs.existsSync(path.join(dir, STOWED_BUNDLE))
    ? harness
    : undefined
}

function packagedWorkerDir(): string | undefined {
  const { resourcesPath } = process as { resourcesPath?: string }
  if (typeof resourcesPath !== 'string') return undefined

  return [
    path.join(resourcesPath, 'app.asar.unpacked', 'qvac', 'worker'),
    path.join(resourcesPath, 'app', 'qvac', 'worker'),
    path.join(resourcesPath, 'qvac', 'worker')
  ].find((dir) => stowedHarness(dir) !== undefined)
}

/**
 * Asset references keep these files visible to bundlers of the host app:
 * `import.meta.asset(<literal>)` on Bare, `new URL(<literal>, import.meta.url)`
 * elsewhere. This module compiles to `dist/src/client/rpc/`.
 */
function sdkWorkerFile(which: 'entry' | 'shim'): string {
  type ImportMetaAsset = { asset?: (spec: string) => string }
  const asset = (import.meta as ImportMetaAsset).asset
  if (which === 'entry') {
    return fileURLToPath(
      asset ? asset('../../worker/index.js') : new URL('../../worker/index.js', import.meta.url)
    )
  }
  return fileURLToPath(
    asset
      ? asset('../../worker/unbundled-shim.js')
      : new URL('../../worker/unbundled-shim.js', import.meta.url)
  )
}

/**
 * The worker to start, in order:
 * 1. QVAC_WORKER_PATH: a bundled worker folder, or a worker entry file
 * 2. The packaged Electron app's bundled worker
 * 3. `qvac/worker/` in the project root, written by `bundleSdk`
 * 4. `qvac/worker.entry.mjs` in the project root, run unbundled
 * 5. The SDK's default worker, run unbundled
 */
function resolveWorkerSource(): WorkerSource {
  const envPath = process.env['QVAC_WORKER_PATH']
  if (envPath) {
    const resolved = path.resolve(envPath)
    const harness = stowedHarness(resolved)
    if (harness) {
      logger.info(`🔧 Using bundled worker from QVAC_WORKER_PATH: ${resolved}`)
      return { harness }
    }
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      logger.info(`🔧 Using worker entry from QVAC_WORKER_PATH: ${resolved}`)
      return { entry: resolved }
    }
    logger.warn(`⚠️ QVAC_WORKER_PATH was set but no worker was found at ${resolved}. Falling back.`)
  }

  const packaged = packagedWorkerDir()
  if (packaged) {
    logger.info(`🔧 Using packaged worker: ${packaged}`)
    return { harness: path.join(packaged, STOWED_HARNESS) }
  }

  const projectRoot = findProjectRootSync()
  if (projectRoot) {
    const harness = stowedHarness(path.join(projectRoot, 'qvac', 'worker'))
    if (harness) {
      logger.info(`🔧 Using bundled worker: ${harness}`)
      return { harness }
    }
    const entry = path.join(projectRoot, 'qvac', 'worker.entry.mjs')
    if (fs.existsSync(entry)) {
      logger.info(`🔧 Using worker entry: ${entry}`)
      return { entry }
    }
  }

  const entry = sdkWorkerFile('entry')
  logger.debug(`🔧 Using default SDK worker: ${entry}`)
  return { entry }
}

const WORKER_SOURCE = resolveWorkerSource()

interface StartingWorker {
  ready: Promise<WorkerIPC>
  /** Stops the worker if it is still starting. */
  abort(): void
}

function startWorker(source: WorkerSource): StartingWorker {
  if ('harness' in source) {
    let aborted = false
    const ready = (async () => {
      const harness = (await import(pathToFileURL(source.harness).href)) as {
        start(): Promise<{ ipc: WorkerIPC }>
      }
      const { ipc } = await harness.start()
      if (aborted) ipc.destroy()
      return ipc
    })()
    return {
      ready,
      abort() {
        aborted = true
      }
    }
  }

  let ipc: WorkerIPC | null = null
  let aborted = false
  const ready = (async () => {
    // Loaded here: bare-sidecar resolves the Bare binary for this platform on load.
    const { default: Sidecar } = await import('bare-sidecar')
    if (aborted) throw new WorkerShutdownError()

    const worker = new host.IPC(
      new Sidecar(sdkWorkerFile('shim'), [source.entry], { stdio: 'inherit' })
    ) as WorkerIPC
    ipc = worker
    await Promise.race([
      worker.ready,
      new Promise<never>((_, reject) => {
        worker.once('close', () => reject(new Error('Worker exited before signalling ready')))
      })
    ])
    return worker
  })()
  return {
    ready,
    abort() {
      aborted = true
      ipc?.destroy()
    }
  }
}

/** Distinguishes "config file failed to load" from "no config file present". */
const CONFIG_UNRESOLVED = Symbol('config-unresolved')

/**
 * The startup timeout has to be known before the worker starts, but the config
 * file is normally read after it (init-hooks). Read it early and hand the same
 * object to init-hooks so the file is not parsed twice. A config that fails to
 * load surfaces from init-hooks, which resolves it again.
 */
async function preresolveConfig(): Promise<QvacConfig | undefined | typeof CONFIG_UNRESOLVED> {
  try {
    return await resolveConfig()
  } catch (error) {
    logger.debug('Config preload for the RPC init timeout failed; using the default', { error })
    return CONFIG_UNRESOLVED
  }
}

function startWithTimeout(timeoutMs: number): Promise<WorkerIPC> {
  return new Promise((resolve, reject) => {
    const starting = startWorker(WORKER_SOURCE)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      starting.abort()
      reject(new RPCInitTimeoutError(timeoutMs))
    }, timeoutMs)

    starting.ready.then(
      (ipc) => {
        if (timedOut) return
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

function watchWorker(ipc: WorkerIPC, controller: AbortController) {
  let exited = false
  ipc.on('exit', () => {
    exited = true
  })
  ipc.on('close', () => {
    if (controller.signal.aborted) return
    logger.info(`🪦 Bare worker ${exited ? 'exited' : 'closed'} unexpectedly`)
    if (workerLifeController === controller) resetModuleState()
    controller.abort(new WorkerCrashedError(null, null))
  })
}

function resetModuleState() {
  rpcInstance = null
  rpcPromise = null
  workerIpc = null
  workerLifeController = null
}

async function ensureRPC(): Promise<RPC> {
  if (rpcInstance) return rpcInstance
  if (rpcPromise) return rpcPromise
  if (closePromise) await closePromise

  const startGeneration = generation
  rpcPromise = (async () => {
    const preresolved = await preresolveConfig()
    const initTimeoutMs = resolveRPCInitTimeoutMs({
      envValue: process.env[RPC_INIT_TIMEOUT_ENV_VAR],
      configValue:
        preresolved === CONFIG_UNRESOLVED
          ? undefined
          : (preresolved?.rpcInitTimeoutMs ?? undefined),
      onInvalidEnvValue: (value) =>
        logger.warn(
          `Ignoring invalid ${RPC_INIT_TIMEOUT_ENV_VAR}=${value}; expected a positive integer of milliseconds`
        )
    })

    const ipc = await startWithTimeout(initTimeoutMs)
    if (startGeneration !== generation) {
      await ipc.terminate()
      throw new WorkerShutdownError()
    }
    const controller = new AbortController()
    workerIpc = ipc
    workerLifeController = controller
    watchWorker(ipc, controller)

    const rpc = new RPC(ipc, () => {})

    const runtimeContext: RuntimeContext = {
      runtime: 'node',
      platform: process.platform as 'darwin' | 'linux' | 'win32'
    }
    // Snap's HOME can be revision-scoped; SNAP_USER_COMMON is stable.
    const homeDir = process.env['SNAP_USER_COMMON'] ?? os.homedir()
    const resolveConfigForInit =
      preresolved === CONFIG_UNRESOLVED ? resolveConfig : async () => preresolved

    await Promise.race([
      initializeConfig(rpc, resolveConfigForInit, runtimeContext, homeDir),
      rejectOnAbort(controller.signal)
    ])

    rpcInstance = rpc
    return rpc
  })()

  try {
    return await rpcPromise
  } catch (error) {
    const ipc = workerIpc
    resetModuleState()
    ipc?.destroy()
    throw error
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () =>
      reject(signal.reason instanceof Error ? signal.reason : new WorkerCrashedError(null, null))
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
  })
}

export function getWorkerLifeSignal(): AbortSignal | null {
  return workerLifeController?.signal ?? null
}

// Called by the RPC layer when it sees the channel close under an in-flight
// call before the worker's `close` event arrives. Tears down now, so the next
// call starts a new worker. A no-op once the life signal has aborted.
export function notifyChannelClosed(): void {
  const controller = workerLifeController
  if (!controller || controller.signal.aborted) return

  const ipc = workerIpc
  resetModuleState()
  controller.abort(new WorkerCrashedError(null, null))
  ipc?.destroy()
}

export async function getRPC() {
  return ensureRPC()
}

export async function createDuplexSession(payload: string, commandId: number) {
  const rpc = await ensureRPC()
  const req = rpc.request(commandId)
  const requestStream = req.createRequestStream()
  const responseStream = req.createResponseStream({ encoding: 'utf-8' })
  requestStream.write(payload, 'utf-8')

  // Destroy on worker death so consumers' for-await throws instead of hangs.
  const lifeSignal = workerLifeController?.signal
  if (lifeSignal && !lifeSignal.aborted) {
    const onAbort = () => {
      const err =
        lifeSignal.reason instanceof Error ? lifeSignal.reason : new WorkerCrashedError(null, null)
      requestStream.destroy(err)
      responseStream.destroy(err)
    }
    lifeSignal.addEventListener('abort', onAbort, { once: true })
  }

  return { requestStream, responseStream }
}

export async function close() {
  if (closePromise) {
    await closePromise
    return
  }

  generation++
  closePromise = (async () => {
    const ipc = workerIpc
    if (!ipc) {
      await rpcPromise?.catch(() => {})
      return
    }

    logger.info('🧹 Closing RPC client')

    // Abort before terminating: the close handler sees planned intent, and any
    // in-flight caller rejects with WorkerShutdownError.
    workerLifeController?.abort(new WorkerShutdownError())
    resetModuleState()
    await ipc.terminate()
  })()

  try {
    await closePromise
  } finally {
    closePromise = null
  }
}
