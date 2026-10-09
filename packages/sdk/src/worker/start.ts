import RPC from 'bare-rpc'
import type { Duplex } from 'bare-stream'
import { close as closeEngine } from '@qvac/inference/engine'
import { registerPlugins } from '@qvac/inference/plugins'
import { registerRpcServerProvider } from '@qvac/inference/rpc-server-provider'
import type { QvacPlugin, RpcServerProvider } from '@qvac/inference/surface'
import { handleRequest } from '@/worker/handle-request'
import { getServerLogger } from '@/logging'

const logger = getServerLogger()

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

  return closeEngine
}
