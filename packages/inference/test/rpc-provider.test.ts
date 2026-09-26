import test from 'brittle'
import env from 'bare-env'
import os from 'bare-os'
import path from 'bare-path'
import net from 'bare-net'
import { startRpcServer, stopRpcServer, discoverRpcServers } from '@/api/rpc-server'
import { send, close } from '@/dispatch'
import { registerRpcServerProvider, hasRpcServerProvider } from '@/rpc/provider'
import { getAllPlugins } from '@/plugins/registry'
import { RpcServerOperationError, PluginsNotRegisteredError } from '@/errors/index'
import type { RpcServerProvider } from '@/schemas/rpc-server'

env['HOME'] = path.join(os.tmpdir(), `qvac-rpc-provider-test-${os.pid()}`)

test('RPC serving reports a missing provider without requiring a model plugin', async (t) => {
  try {
    try {
      await startRpcServer()
      t.fail('start must reject without a provider')
    } catch (error) {
      t.ok(error instanceof RpcServerOperationError)
      if (error instanceof RpcServerOperationError) {
        t.is(error.operation, 'startRpcServer')
        t.ok(error.details.includes('No RPC server provider registered'))
      }
    }
    await t.exception(send({ type: 'heartbeat' }), PluginsNotRegisteredError)
  } finally {
    await close()
  }
})

test('RPC discovery works without a provider or model plugins', async (t) => {
  try {
    t.is(getAllPlugins().length, 0)
    t.absent(hasRpcServerProvider())
    t.alike(await discoverRpcServers({ topic: `provider-test-${Date.now()}`, timeoutMs: 100 }), [])
    await t.exception(send({ type: 'heartbeat' }), PluginsNotRegisteredError)
  } finally {
    await close()
  }
})

test('a server-only provider owns handles through stop failure and close retry', async (t) => {
  let failStop = true
  let stops = 0
  const provider: RpcServerProvider = {
    async start(options) {
      t.absent('discoveryTopic' in options, 'discovery stays in the engine')
      const listener = net.createServer((socket) => {
        socket.on('error', () => {})
        socket.resume()
      })
      await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
      const address = listener.address()
      if (!address || typeof address === 'string') throw new Error('No listening address')
      return {
        host: '127.0.0.1',
        port: address.port,
        url: `127.0.0.1:${address.port}`,
        runtime: 'in-process',
        rdmaCapable: false,
        async stop() {
          stops++
          if (failStop) throw new Error('temporary stop failure')
          await new Promise<void>((resolve) => listener.close(() => resolve()))
        }
      }
    }
  }
  registerRpcServerProvider(provider)
  try {
    t.is(getAllPlugins().length, 0, 'no dummy model plugin')
    const server = await startRpcServer()
    t.is((await send({ type: 'heartbeat' })).type, 'heartbeat')
    await t.exception(() => registerRpcServerProvider(provider), /already registered/)
    await t.exception(stopRpcServer({ serverId: server.serverId }), /temporary stop failure/)
    await t.exception(close(), /Failed to stop owned/)
    t.ok(hasRpcServerProvider(), 'failed cleanup retains registration')
    failStop = false
    await close()
    t.is(stops, 3)
    t.absent(hasRpcServerProvider(), 'successful close clears registration')
    await t.exception(startRpcServer(), /No RPC server provider registered/)
  } finally {
    failStop = false
    await close()
  }
})
