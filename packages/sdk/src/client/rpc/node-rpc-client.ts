import RPC from 'bare-rpc'
import type host from 'bare-stow/host'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { initializeConfig } from '@/client/init-hooks'
import { resolveConfig } from '@/client/config-loader/resolve-config.node'
import { getClientLogger } from '@/logging'
import {
  WorkerCrashedError,
  WorkerFileNotFoundError,
  WorkerShutdownError,
  WorkerStartupError
} from '@/utils/errors-client'
import type { RuntimeContext } from '@qvac/inference/surface'
import { getPearRuntime, type PearRuntime } from './pear-runtime'
import { start as startUnbundled } from './unbundled-harness'

type WorkerIPC = InstanceType<typeof host.IPC>

interface Harness {
  start(...args: unknown[]): Promise<{ ipc: WorkerIPC }>
}

/**
 * The bare-stow harness in a folder written by `bundleSdk` for `bare-sidecar`
 * or `pear-runtime`, or a worker entry run unbundled.
 */
type WorkerSource = { harness: string } | { harness: string; pear: PearRuntime } | { entry: string }

const logger = getClientLogger()

const SIDECAR_HARNESS = 'index.mjs'
const PEAR_HARNESS = 'index.cjs'
const STOWED_BUNDLE = 'index.bundle'
const WORKER_READY_TIMEOUT_MS = 60_000

let rpcInstance: RPC | null = null
let rpcPromise: Promise<RPC> | null = null
let worker: WorkerIPC | null = null
let closePromise: Promise<void> | null = null
// Bumped by close(); a start that finishes under an older generation stops its
// own worker, so a caller waiting on that start never receives a closed client.
let generation = 0
// Aborted when the worker dies (crash) or close() runs (planned).
let workerLifeController: AbortController | null = null
const workerErrors = new WeakMap<WorkerIPC, unknown>()

function findProjectRootSync(): string | undefined {
  let dir = process.cwd()
  const root = path.parse(dir).root

  while (dir !== root) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }

  return undefined
}

function stowedHarness(dir: string, harnessFile = SIDECAR_HARNESS): string | undefined {
  const harness = path.join(dir, harnessFile)
  return fs.existsSync(harness) && fs.existsSync(path.join(dir, STOWED_BUNDLE))
    ? harness
    : undefined
}

function packagedWorkerDirs(): string[] {
  const { resourcesPath } = process as { resourcesPath?: string }
  if (typeof resourcesPath !== 'string') return []

  return [
    path.join(resourcesPath, 'app.asar.unpacked', 'qvac', 'worker'),
    path.join(resourcesPath, 'app', 'qvac', 'worker'),
    path.join(resourcesPath, 'qvac', 'worker')
  ]
}

/**
 * An asset reference keeps the file visible to bundlers of the host app:
 * `import.meta.asset(<literal>)` on Bare, `new URL(<literal>, import.meta.url)`
 * elsewhere. This module compiles to `dist/src/client/rpc/`.
 */
function sdkWorkerEntry(): string {
  type ImportMetaAsset = { asset?: (spec: string) => string }
  const asset = (import.meta as ImportMetaAsset).asset
  return fileURLToPath(
    asset ? asset('../../worker/index.js') : new URL('../../worker/index.js', import.meta.url)
  )
}

/**
 * With a Pear runtime registered, the `pear-runtime` bundle from
 * QVAC_WORKER_PATH, the packaged app, or `qvac/worker/` in the project root.
 */
function resolvePearWorkerSource(pear: PearRuntime): WorkerSource {
  const envPath = process.env['QVAC_WORKER_PATH']
  const projectRoot = findProjectRootSync()
  const projectWorkerDir = path.join(projectRoot ?? process.cwd(), 'qvac', 'worker')
  const dirs = [
    ...(envPath ? [path.resolve(envPath)] : []),
    ...packagedWorkerDirs(),
    projectWorkerDir
  ]

  for (const dir of dirs) {
    const harness = stowedHarness(dir, PEAR_HARNESS)
    if (harness) {
      logger.info(`🔧 Using Pear worker: ${harness}`)
      return { harness, pear }
    }
  }
  throw new WorkerFileNotFoundError(path.join(projectWorkerDir, PEAR_HARNESS))
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
  const pear = getPearRuntime()
  if (pear) return resolvePearWorkerSource(pear)

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

  for (const dir of packagedWorkerDirs()) {
    const harness = stowedHarness(dir)
    if (harness) {
      logger.info(`🔧 Using packaged worker: ${harness}`)
      return { harness }
    }
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

  const entry = sdkWorkerEntry()
  logger.debug(`🔧 Using default SDK worker: ${entry}`)
  return { entry }
}

async function importHarness(file: string): Promise<Harness> {
  const loaded = (await import(pathToFileURL(file).href)) as Partial<Harness> & {
    default?: Harness
  }
  return typeof loaded.start === 'function' ? (loaded as Harness) : loaded.default!
}

async function launchWorker(source: WorkerSource): Promise<WorkerIPC> {
  const options = { timeout: WORKER_READY_TIMEOUT_MS }
  if ('entry' in source) return (await startUnbundled(source.entry, options)).ipc
  const harness = await importHarness(source.harness)
  const { ipc } = 'pear' in source ? await harness.start(source.pear) : await harness.start(options)
  return ipc
}

async function startWorker(source: WorkerSource): Promise<WorkerIPC> {
  let ipc: WorkerIPC
  try {
    ipc = await launchWorker(source)
  } catch (error) {
    throw new WorkerStartupError('Worker failed before signalling ready', error)
  }
  ipc.on('error', (error: unknown) => workerErrors.set(ipc, error))
  return ipc
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
    controller.abort(new WorkerCrashedError(workerErrors.get(ipc)))
  })
}

function resetModuleState() {
  rpcInstance = null
  rpcPromise = null
  worker = null
  workerLifeController = null
}

async function ensureRPC(): Promise<RPC> {
  if (rpcInstance) return rpcInstance
  if (rpcPromise) return rpcPromise
  if (closePromise) await closePromise

  const startGeneration = generation
  const attempt = (async () => {
    const started = await startWorker(resolveWorkerSource())
    if (startGeneration !== generation) {
      await started.terminate()
      throw new WorkerShutdownError()
    }
    const controller = new AbortController()
    worker = started
    workerLifeController = controller
    watchWorker(started, controller)

    const rpc = new RPC(started, () => {})

    const runtimeContext: RuntimeContext = {
      runtime: 'node',
      platform: process.platform as 'darwin' | 'linux' | 'win32'
    }
    // Snap's HOME can be revision-scoped; SNAP_USER_COMMON is stable.
    const homeDir = process.env['SNAP_USER_COMMON'] ?? os.homedir()

    await Promise.race([
      initializeConfig(rpc, resolveConfig, runtimeContext, homeDir),
      rejectOnAbort(controller.signal)
    ])

    rpcInstance = rpc
    return rpc
  })()
  rpcPromise = attempt

  try {
    return await attempt
  } catch (error) {
    if (startGeneration === generation) {
      const failed = worker
      const failedController = workerLifeController
      resetModuleState()
      failedController?.abort(error)
      failed?.destroy()
    }
    throw error
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () =>
      reject(signal.reason instanceof Error ? signal.reason : new WorkerCrashedError())
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

  const closed = worker
  resetModuleState()
  controller.abort(new WorkerCrashedError(closed ? workerErrors.get(closed) : undefined))
  closed?.destroy()
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
      const err = lifeSignal.reason instanceof Error ? lifeSignal.reason : new WorkerCrashedError()
      requestStream.destroy(err)
      responseStream.destroy(err)
    }
    lifeSignal.addEventListener('abort', onAbort, { once: true })
    responseStream.once('close', () => lifeSignal.removeEventListener('abort', onAbort))
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
    const closing = worker
    if (!closing) {
      const pending = rpcPromise
      rpcPromise = null
      await pending?.catch(() => {})
      return
    }

    logger.info('🧹 Closing RPC client')

    // Abort before terminating: the close handler sees planned intent, and any
    // in-flight caller rejects with WorkerShutdownError.
    workerLifeController?.abort(new WorkerShutdownError())
    resetModuleState()
    await closing.terminate()
  })()

  try {
    await closePromise
  } finally {
    closePromise = null
  }
}
