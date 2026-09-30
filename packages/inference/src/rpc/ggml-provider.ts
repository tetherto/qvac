import { startRpcServer } from '@qvac/ggml-rpc-server'
import type { RpcServerProvider } from '@/schemas/rpc-server'

/** Optional native adapter. Import this subpath only in workers assembled for RPC serving. */
export const ggmlRpcServerProvider: RpcServerProvider = {
  async start(options) {
    const handle = await startRpcServer({
      ...(options.host !== undefined && { host: options.host }),
      ...(options.port !== undefined && { port: options.port }),
      ...(options.device !== undefined && { device: options.device }),
      ...(options.cache !== undefined && { cache: options.cache }),
      ...(options.threads !== undefined && { threads: options.threads }),
      ...(options.expectRdma !== undefined && { expectRdma: options.expectRdma }),
      ...(options.allowNonLoopbackHost !== undefined && {
        allowNonLoopbackHost: options.allowNonLoopbackHost
      })
    })
    return {
      host: handle.host,
      port: handle.port,
      url: handle.url,
      rdmaCapable: handle.rdmaCapable,
      stop: () => handle.stop()
    }
  }
}

export default ggmlRpcServerProvider
