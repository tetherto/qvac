import RPC from 'bare-rpc'
import os from 'bare-os'
import { setTimeout } from 'bare-timers'
import { isBareKit } from 'which-runtime'
import type { Duplex } from 'bare-stream'
import { close as closeEngine } from '@qvac/inference/engine'
import { registerPlugins } from '@qvac/inference/plugins'
import { registerRpcServerProvider } from '@qvac/inference/rpc-server-provider'
import type { QvacPlugin, RpcServerProvider } from '@qvac/inference/surface'
import { handleRequest } from '@/worker/handle-request'
import { getServerLogger } from '@/logging'

const logger = getServerLogger()

// Bound on how long a desktop worker may outlive `stop()`; a native handle that
// cannot be cancelled (QVAC-18197) would otherwise keep the process alive.
const FORCE_EXIT_GRACE_MS = 3_000

export interface WorkerOptions {
  plugins: readonly QvacPlugin[]
  rpcServerProvider?: RpcServerProvider | undefined
}

export type StopWorker = () => Promise<void>

export function startWorker(ipc: Duplex, ready: () => void, options: WorkerOptions): StopWorker {
  registerPlugins(options.plugins)
  if (options.rpcServerProvider) registerRpcServerProvider(options.rpcServerProvider)

  new RPC(ipc, handleRequest)
  logger.info(`Worker ready with ${options.plugins.length} plugins`)
  ready()

  return stopWorker
}

async function stopWorker(): Promise<void> {
  try {
    await closeEngine()
  } finally {
    if (!isBareKit) scheduleForceExit()
  }
}

function scheduleForceExit(): void {
  setTimeout(() => {
    logger.error(`Worker still running ${FORCE_EXIT_GRACE_MS}ms after stop; killing it`)
    os.kill(os.pid(), 'SIGKILL')
  }, FORCE_EXIT_GRACE_MS).unref()
}
