import { createRpcServerManager } from './manager'
import { advertiseRpcServer } from './discovery'
import { waitForReady } from './network'

export const rpcServers = createRpcServerManager({
  async start(options) {
    // Defer native loading so local inference does not initialize the RPC addon.
    const native = await import('@qvac/ggml-rpc-server')
    const handle = await native.startRpcServer({
      ...(options.host !== undefined && { host: options.host }),
      ...(options.port !== undefined && { port: options.port }),
      ...(options.device !== undefined && { device: options.device }),
      ...(options.cache !== undefined && { cache: options.cache }),
      ...(options.threads !== undefined && { threads: options.threads }),
      ...(options.allowNonLoopbackHost !== undefined && {
        allowNonLoopbackHost: options.allowNonLoopbackHost
      })
    })
    // The package's Bare condition selects mobile.js on desktop Bare as well.
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
  },
  ready: (server, ctx) => waitForReady(server.host, server.port, ctx.signal),
  advertise: advertiseRpcServer
})
