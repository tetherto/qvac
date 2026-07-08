import { destroySwarm } from './swarm'
import { initEnv } from './env'
import { closeAllRagInstances } from './rag'
import { cleanupDownloads } from './handlers/load-model/download-manager'
import { unloadAllModels } from './state/model-registry'
import { closeRegistryClient } from './state/registry-client'
import {
  clearAllLoggingStreams,
  startLogBuffering,
  stopLogBufferingWithTimeout
} from './state/logging-stream-registry'
import { clearAllAddonLoggers, getEngineLogger, LOG_ID, ALL_LOG_ID } from '../logging'
import { clearPlugins } from '../plugins'
import { acquireWorkerLock, releaseWorkerLock } from './utils/worker-lock'

// The engine runs in-process on the host's Bare runtime. Unlike a spawned
// worker, it never owns process signals or `Bare.exit` — the host application
// controls the process lifecycle. This module only sets up the shared engine
// state and tears it back down on `close()`.

let initialized = false
let cleanupRan = false

const logger = getEngineLogger()

/**
 * Initialize the in-process engine: start log buffering, read env, and acquire
 * the worker lock (guards the cache dir against a second engine in the same
 * home). Idempotent.
 */
export function initialize(): void {
  if (initialized) return

  startLogBuffering(LOG_ID)
  startLogBuffering(ALL_LOG_ID)

  initEnv()
  acquireWorkerLock()

  // The engine serves requests in-process immediately, so a `subscribeServerLogs`
  // consumer can attach right away. Bound the global startup buffer the same way
  // model-load buffering is bounded: if nothing subscribes within the grace
  // window, stop buffering so every server log doesn't keep churning it. A
  // subscriber that connects in time cancels the timeout and flushes the buffer.
  stopLogBufferingWithTimeout(ALL_LOG_ID)

  initialized = true
  logger.debug('Engine initialized')
}

export function isInitialized(): boolean {
  return initialized
}

function clearRegistries(): void {
  clearAllLoggingStreams()
  clearAllAddonLoggers()
  clearPlugins()
}

/**
 * Run the shared cleanup body: clear plugin registries (each addon's
 * `releaseLogger` frees env-bound `js_ref_t` state), unload all loaded models
 * (each addon's `destroyInstance`), and close infra (swarm, RAG, downloads,
 * registry client). Idempotent. Does not release the worker lock.
 */
async function runCleanup(): Promise<void> {
  if (cleanupRan) return
  cleanupRan = true
  clearRegistries()
  await Promise.allSettled([
    destroySwarm(),
    closeAllRagInstances(),
    cleanupDownloads(),
    unloadAllModels(),
    closeRegistryClient()
  ])
}

/**
 * Pre-terminate cleanup, callable while the isolate is still alive. Runs the
 * shared cleanup body without releasing the worker lock, leaving the host to
 * tear the runtime down. Addons hold static `js_ref_t` handles into the current
 * isolate; without this cleanup they survive into the next isolate and crash on
 * first access.
 */
export async function cleanupForTerminate(): Promise<void> {
  if (cleanupRan) return
  logger.info('🧹 Pre-terminate cleanup starting...')
  try {
    await runCleanup()
    logger.info('✅ Pre-terminate cleanup completed')
  } catch (error) {
    logger.error('❌ Error during pre-terminate cleanup:', error)
  }
}

/**
 * Tear the engine down: run cleanup and release the worker lock. Safe to call
 * more than once. Does not exit the process — the host owns that.
 */
export async function close(): Promise<void> {
  try {
    await runCleanup()
  } catch (error) {
    logger.error('❌ Error during cleanup:', error)
  }
  releaseWorkerLock()
  initialized = false
  cleanupRan = false
}
