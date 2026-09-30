import test from 'brittle'
import { AbortController } from 'bare-abort-controller'
import { ggmlRpcServerProvider } from '@/rpc/ggml-provider'
import { queryRpcDevices } from '@/rpc/inventory'
import { rpcServerInfoSchema } from '@/schemas/rpc-server'

test('published RPC provider starts, serves inventory over TCP, and stops', async (t) => {
  const server = await ggmlRpcServerProvider.start({})
  try {
    t.is(typeof server.rdmaCapable, 'boolean')
    t.ok(rpcServerInfoSchema.safeParse({ ...server, serverId: 'native' }).success)
    const devices = await queryRpcDevices(
      server.host,
      server.port,
      5000,
      new AbortController().signal
    )
    t.ok(devices && devices.length > 0, 'native server answers TCP inventory probes')
  } finally {
    await server.stop()
  }
  t.is(
    await queryRpcDevices(server.host, server.port, 100, new AbortController().signal),
    undefined,
    'stopped endpoint is unreachable'
  )
})
