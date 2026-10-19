import test from 'brittle'
import { AbortController } from 'bare-abort-controller'
import { RpcServerRdmaUnavailableError } from '@qvac/ggml-rpc-server'
import { ggmlRpcServerProvider } from '@/rpc/ggml-provider'
import { queryRpcInventory } from '@/rpc/inventory'
import { rpcServerInfoSchema } from '@/schemas/rpc-server'
import { ModelType } from '@/schemas/model-types'
import { registerRpcServerProvider } from '@/rpc/provider'
import { handleStartRpcServer } from '@/handlers/rpc-server'
import { registerModel, getAllModelIds } from '@/runtime/model-registry'
import { close, cleanupForTerminate } from '@/runtime/lifecycle'
import { RpcServerOperationError } from '@/errors/index'
import { rpcServers } from '@/rpc/instance'

test('published RPC provider starts, serves inventory over TCP, and stops', async (t) => {
  const server = await ggmlRpcServerProvider.start({})
  try {
    t.is(typeof server.rdmaCapable, 'boolean')
    t.ok(rpcServerInfoSchema.safeParse({ ...server, serverId: 'native' }).success)
    const inventory = await queryRpcInventory(
      server.host,
      server.port,
      5000,
      new AbortController().signal
    )
    t.ok(inventory && inventory.devices.length > 0, 'native server answers TCP inventory probes')
    t.is(typeof inventory?.rdmaAvailable, 'boolean')
    if (!server.rdmaCapable) {
      t.is(inventory?.rdmaAvailable, false, 'TCP backend does not offer RDMA')
    }
  } finally {
    await server.stop()
  }
  t.is(
    await queryRpcInventory(server.host, server.port, 100, new AbortController().signal),
    undefined,
    'stopped endpoint is unreachable'
  )
})

test('SDK RPC starts preserve native port allocation and enforce runtime RDMA availability', async (t) => {
  registerRpcServerProvider(ggmlRpcServerProvider)
  try {
    const servers = await Promise.all([
      handleStartRpcServer({ type: 'startRpcServer' }),
      handleStartRpcServer({ type: 'startRpcServer' })
    ])
    t.not(servers[0]!.serverId, servers[1]!.serverId)
    t.not(servers[0]!.url, servers[1]!.url, 'native servers bind distinct ports')
    for (const server of servers) {
      t.ok(server.url.startsWith('127.0.0.1:'))
      const port = Number(server.url.slice(server.url.lastIndexOf(':') + 1))
      t.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'URL contains the bound port')
    }

    const strict = handleStartRpcServer({ type: 'startRpcServer', expectRdma: true })
    if (servers[0]!.rdmaCapable) {
      t.is((await strict).rdmaCapable, true, 'required RDMA is reported when available')
    } else {
      const error = await strict.then(
        () => undefined,
        (cause: unknown) => cause
      )
      t.ok(error instanceof RpcServerOperationError, 'SDK reports the failed start')
      if (error instanceof RpcServerOperationError) {
        t.is(error.operation, 'startRpcServer')
        t.ok(error.details.includes('RDMA is not available'))
        t.ok(error.cause instanceof RpcServerRdmaUnavailableError, 'native cause is preserved')
      }
      t.is(rpcServers.size, 2, 'failed strict start adds no owned server')
    }
  } finally {
    await close()
  }
})

for (const cleanup of [close, cleanupForTerminate]) {
  test(`${cleanup.name} keeps owned RPC servers alive until model unload completes`, async (t) => {
    let releaseUnload!: () => void
    let enteredUnload!: () => void
    const unloading = new Promise<void>((resolve) => {
      enteredUnload = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseUnload = resolve
    })
    let stopCalls = 0
    registerRpcServerProvider({
      async start(options) {
        const server = await ggmlRpcServerProvider.start(options)
        return {
          ...server,
          async stop() {
            stopCalls++
            await server.stop()
          }
        }
      }
    })
    let closing: Promise<void> | undefined
    try {
      const server = await handleStartRpcServer({ type: 'startRpcServer' })
      registerModel('rpc-cleanup-consumer', {
        path: 'rpc-cleanup-fixture',
        modelType: ModelType.llamacppCompletion,
        config: { 'rpc-servers': server.url },
        model: {
          async load() {},
          async run() {
            throw new Error('Cleanup fixture does not run inference')
          },
          async pause() {},
          async unload() {
            enteredUnload()
            await gate
            t.is(stopCalls, 0, 'RPC server stays alive through model resource release')
          }
        }
      })
      closing = cleanup()
      await unloading
      t.is(stopCalls, 0, 'RPC server stop waits for pending model unload')
      releaseUnload()
      await closing
      t.is(stopCalls, 1, 'RPC server stops after model unload')
      t.alike(getAllModelIds(), [], 'model registry is empty after cleanup')
    } finally {
      releaseUnload()
      await closing
      await close()
    }
  })
}
