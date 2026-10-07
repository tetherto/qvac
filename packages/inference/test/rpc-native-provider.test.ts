import test from 'brittle'
import { AbortController } from 'bare-abort-controller'
import { ggmlRpcServerProvider } from '@/rpc/ggml-provider'
import { queryRpcInventory } from '@/rpc/inventory'
import { rpcServerInfoSchema } from '@/schemas/rpc-server'
import { ModelType } from '@/schemas/model-types'
import { registerRpcServerProvider } from '@/rpc/provider'
import { handleStartRpcServer } from '@/handlers/rpc-server'
import { registerModel, getAllModelIds } from '@/runtime/model-registry'
import { close, cleanupForTerminate } from '@/runtime/lifecycle'

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
