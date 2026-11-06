import RPC from 'bare-rpc'
import { connect } from 'bare-net'
import Signal from 'bare-signals'
import AbortController from 'bare-abort-controller'
import { createRpcServerManager } from '../../../inference/dist/rpc/manager.js'
import { advertiseRpcServer } from '../../../inference/dist/rpc/discovery.js'
import { createRequestRegistry } from '../../../inference/dist/runtime/request-context.js'
import { handleRpcServerStatusStream } from '../../../inference/dist/handlers/rpc-server.js'

const { QVAC_IPC_SOCKET_PATH: socketPath } = JSON.parse(Bare.argv[2])
const manager = createRpcServerManager({
  async start() {
    return {
      host: '10.0.0.2',
      port: 50052,
      url: '10.0.0.2:50052',
      rdmaCapable: false,
      async stop() {}
    }
  },
  async ready() {},
  advertise(topic, url, ctx, onstatus) {
    return advertiseRpcServer(
      topic,
      url,
      ctx,
      (options) => {
        let suspended = true
        let sends = 0
        return {
          get suspended() {
            return suspended
          },
          async start() {
            suspended = false
            options.onstart?.()
          },
          async send() {
            if (suspended) return
            if (++sends === 1) return
            const error = Object.assign(
              new Error('UDP send failed', { cause: new Error('network removed') }),
              { code: 'ENETDOWN' }
            )
            suspended = true
            options.onstop?.(error)
            throw error
          },
          async suspend() {
            suspended = true
            options.onstop?.()
          },
          async resume() {},
          async close() {
            suspended = true
            options.onstop?.()
          }
        }
      },
      onstatus
    )
  }
})
const registry = createRequestRegistry()
new RPC(connect(socketPath), (req) => {
  const request = JSON.parse(req.data.toString())
  if (request.type === '__init_config') {
    req.reply(JSON.stringify({ success: true }), 'utf-8')
    return
  }
  if (request.type !== 'rpcServerStatusStream') return
  const wire = req.createResponseStream()
  const controller = new AbortController()
  wire.on('close', () => controller.abort(undefined))
  void (async () => {
    for await (const status of handleRpcServerStatusStream(
      request,
      { signal: controller.signal },
      manager
    )) {
      wire.write(JSON.stringify(status) + '\n', 'utf-8')
    }
  })()
  void (async () => {
    await using ctx = await registry.begin({ requestId: 'status-server', kind: 'rpcServer' })
    await manager.start(
      { host: '10.0.0.2', allowNonLoopbackHost: true, discoveryTopic: 'status-test' },
      ctx
    )
  })()
})
const signals = new Signal.Emitter()
signals.once('SIGTERM', () => Bare.exit(0))
