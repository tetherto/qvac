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
      ...(options.allowNonLoopbackHost !== undefined && {
        allowNonLoopbackHost: options.allowNonLoopbackHost
      })
    })
    // The Bare export uses the in-process server on desktop and mobile.
    const runtime: string = handle.runtime
    if (runtime !== 'in-process' || handle.rdmaCapable) {
      await handle.stop()
      throw new Error('Inference requires the Bare in-process TCP RPC server')
    }
    return {
      host: handle.host,
      port: handle.port,
      url: handle.url,
      runtime: 'in-process',
      rdmaCapable: false,
      stop: () => handle.stop()
    }
  }
}

export default ggmlRpcServerProvider
