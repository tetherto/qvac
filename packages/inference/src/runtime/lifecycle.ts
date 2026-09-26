import { closeRpcResources } from '@/handlers/rpc-server'
import { initEnv } from '@/runtime/env'
import { closeAllRagInstances } from '@/rag/index'
import { disposeAllVectorIndexes } from '@/runtime/vector-index-registry'
import { cleanupDownloads } from '@/handlers/load-model/download-manager'
import { unloadAllModels } from '@/runtime/model-registry'
import { closeRegistryClient } from '@/runtime/registry-client'
import {
  clearAllLoggingStreams,
  startLogBuffering,
  stopLogBufferingWithTimeout
} from '@/runtime/logging-stream-registry'
import { clearAllAddonLoggers, getEngineLogger, LOG_ID, ALL_LOG_ID } from '@/logging/index'
import { clearPlugins } from '@/plugins/index'
import { acquireCacheLock, releaseCacheLock } from '@/runtime/cache-lock'
import { nativeResourceCollectorDependencies } from '@/resources/native'
import { destroyResourceCollector, initializeResourceCollector } from '@/resources/instance'

// The host application owns the Bare runtime lifecycle: this module sets up the
// shared engine state and tears it back down on `close()`, but never claims
// process signals or calls `Bare.exit`.

let initialized = false
let cleanupRan = false
let cleanupPromise: Promise<void> | null = null

const logger = getEngineLogger()

/**
 * Initialize the engine: start log buffering, read env, and acquire the cache
 * lock (guards the cache dir against a second instance in the same home).
 * Idempotent.
 */
export function initialize(): void {
  if (initialized) return

  startLogBuffering(LOG_ID)
  startLogBuffering(ALL_LOG_ID)

  initEnv()
  acquireCacheLock()
  initializeResourceCollector(nativeResourceCollectorDependencies)

  // A `subscribeServerLogs` consumer can attach right away. Bound the global
  // startup buffer the same way model-load buffering is bounded: if nothing
  // subscribes within the grace window, stop buffering so the buffer doesn't
  // keep churning. A subscriber that connects in time cancels the timeout and
  // flushes the buffer.
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
 * registry client). Idempotent. Does not release the cache lock.
 */
async function runCleanup(): Promise<void> {
  if (cleanupPromise) return cleanupPromise
  if (cleanupRan) return
  cleanupPromise = (async () => {
    destroyResourceCollector()
    clearRegistries()
    disposeAllVectorIndexes()
    const results = await Promise.allSettled([
      closeRpcResources(),
      closeAllRagInstances(),
      cleanupDownloads(),
      unloadAllModels(),
      closeRegistryClient()
    ])
    const rpcCleanup = results[0]!
    if (rpcCleanup.status === 'rejected') throw rpcCleanup.reason
    cleanupRan = true
  })()
  try {
    await cleanupPromise
  } finally {
    cleanupPromise = null
  }
}

/**
 * Pre-terminate cleanup, callable while the isolate is still alive. Runs the
 * shared cleanup body without releasing the cache lock, leaving the host to
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
    throw error
  }
}

/**
 * Tear the engine down: run cleanup and release the cache lock. Safe to call
 * more than once. Does not exit the process — the host owns that.
 */
export async function close(): Promise<void> {
  try {
    await runCleanup()
  } catch (error) {
    logger.error('❌ Error during cleanup:', error)
    throw error
  }
  releaseCacheLock()
  initialized = false
  cleanupRan = false
}
