import { createRpcServerManager } from './manager'
import { advertiseRpcServer } from './discovery'
import { waitForReady } from './network'
import { getRpcServerProvider } from './provider'

export const rpcServers = createRpcServerManager({
  async start(options) {
    return getRpcServerProvider().start({
      ...(options.host !== undefined && { host: options.host }),
      ...(options.port !== undefined && { port: options.port }),
      ...(options.device !== undefined && { device: options.device }),
      ...(options.cache !== undefined && { cache: options.cache }),
      ...(options.threads !== undefined && { threads: options.threads }),
      ...(options.allowNonLoopbackHost !== undefined && {
        allowNonLoopbackHost: options.allowNonLoopbackHost
      })
    })
  },
  ready: (server, ctx) => waitForReady(server.host, server.port, ctx.signal),
  advertise: advertiseRpcServer
})
