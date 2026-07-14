import os from 'bare-os'
import Signal from 'bare-signals'
import { createBareKitRPCServer, createIPCClient } from '@/worker/create-server'
import { initEnv, getValidatedEnv } from '@/server/env'
import {
  close as closeCore,
  cleanupForTerminate as cleanupCoreForTerminate
} from '@qvac/core/engine'
import { getServerLogger } from '@/logging'
import { acquireWorkerLock, releaseWorkerLock } from '@/server/utils/worker-lock'

let coreInitialized = false
let rpcInitialized = false
// Set true when shutdownWorker is in flight, so a later
// SIGTERM/SIGINT/uncaught-exception does not re-run releaseWorkerLock + Bare.exit.
let isShuttingDown = false

const logger = getServerLogger()

// Defense-in-depth grace period for the SIGKILL safety net armed before
// Bare.exit() in shutdownWorker. If Bare.exit cannot
// terminate the worker within this window — typically because some path
// holds a non-cancellable native handle (e.g. a libuv worker thread
// blocked on flock; see QVAC-18197) — we force-kill the OS process to
// guarantee bounded shutdown time.
const FORCE_EXIT_GRACE_MS = 3_000

function scheduleForceExit(): void {
  const timer: unknown = setTimeout(() => {
    logger.error(
      `Bare.exit did not terminate the worker within ${FORCE_EXIT_GRACE_MS}ms — ` +
        `force-killing self (likely blocked native handle)`
    )
    try {
      os.kill(os.pid(), 'SIGKILL')
    } catch {
      // best-effort — if SIGKILL itself fails, there's nothing more to do
    }
  }, FORCE_EXIT_GRACE_MS)
  // Don't let the safety-net timer keep the process alive on the happy
  // path. Bare returns an object (not a number) from setTimeout.
  if (timer && typeof timer === 'object' && 'unref' in timer) {
    ;(timer as { unref: () => void }).unref()
  }
}

export function initializeWorkerCore(): { hasRPCConfig: boolean } {
  if (coreInitialized) {
    const validatedEnv = getValidatedEnv()
    return { hasRPCConfig: !!validatedEnv.QVAC_IPC_SOCKET_PATH }
  }

  const { hasRPCConfig } = initEnv()

  acquireWorkerLock()
  setupShutdownHandlers()

  coreInitialized = true

  logger.debug('Worker core initialized')
  logger.debug('Arguments to worker:', Bare.argv)

  return { hasRPCConfig }
}

export function ensureRPCSetup() {
  if (rpcInitialized) return

  if (!coreInitialized) {
    initializeWorkerCore()
  }

  try {
    const validatedEnv = getValidatedEnv()
    const ipcSocketPath = validatedEnv.QVAC_IPC_SOCKET_PATH

    if (ipcSocketPath) {
      logger.info(`Running in desktop mode, connecting to IPC socket: ${ipcSocketPath}`)
      const rpc = createIPCClient(ipcSocketPath, {
        onDisconnect: () => void shutdownWorker('ipc-disconnect')
      })
      logger.debug('Desktop IPC client created?', !!rpc)
    } else {
      logger.info('Running in BareKit IPC mode')
      createBareKitRPCServer()
    }

    logger.info('Bare worker started and listening for RPC requests')
    logger.debug('Working directory:', os.cwd())
    rpcInitialized = true
  } catch (error) {
    logger.error('Worker error:', error)
    Bare.exit(1)
  }
}

export function isCoreInitialized(): boolean {
  return coreInitialized
}

export type WorkerShutdownReason =
  'signal' | 'rpc-close' | 'uncaught-exception' | 'unhandled-rejection' | 'ipc-disconnect'

/**
 * Pre-terminate cleanup, callable while the worker is still alive.
 *
 * On platforms where the worker lives in the same OS process as the JS host
 * (i.e. mobile via react-native-bare-kit Worklet), `Bare.exit()` would kill the
 * entire app. This path runs the engine's cleanup (models, swarm, RAG,
 * downloads, registry client, plugin/addon registries) without releasing the
 * worker lock or exiting, leaving the caller (typically the SDK client about to
 * call `worklet.terminate()`) responsible for tearing the worker down.
 *
 * Critical for clean termination: addons hold static state with js_ref_t
 * handles into the current V8 isolate; without this cleanup, those refs survive
 * into the next worklet's isolate and crash on first access.
 */
export async function cleanupForTerminate(): Promise<void> {
  await cleanupCoreForTerminate()
}

export async function shutdownWorker(reason: WorkerShutdownReason): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true

  const messages: Record<WorkerShutdownReason, string> = {
    signal: '🐻 Bare worker shutdown signal received, cleaning up...',
    'rpc-close': '🧹 Worker RPC closed, cleaning up...',
    'uncaught-exception': '💥 Uncaught exception, cleaning up...',
    'unhandled-rejection': '💥 Unhandled rejection, cleaning up...',
    'ipc-disconnect': '🔌 Parent IPC disconnected, cleaning up...'
  }
  logger.info(messages[reason])

  try {
    // Idempotent: if cleanupForTerminate already ran, this only releases the
    // engine's cache lock.
    await closeCore()
    logger.info('✅ Cleanup completed successfully')
  } catch (error) {
    logger.error('❌ Error during shutdown cleanup:', error)
  }

  releaseWorkerLock()

  scheduleForceExit()

  const isGraceful = reason === 'signal' || reason === 'rpc-close'
  Bare.exit(isGraceful ? 0 : 1)
}

function setupShutdownHandlers() {
  const signals = new Signal.Emitter()
  signals.unref()
  signals.once('SIGTERM', () => void shutdownWorker('signal'))
  signals.once('SIGINT', () => void shutdownWorker('signal'))

  Bare.on('uncaughtException', (err) => {
    logger.error('Uncaught exception in worker:', err)
    void shutdownWorker('uncaught-exception')
  })

  Bare.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection in worker:', reason)
    void shutdownWorker('unhandled-rejection')
  })
}
