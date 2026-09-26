import test from 'brittle'
import env from 'bare-env'
import os from 'bare-os'
import path from 'bare-path'
import net from 'bare-net'
import { startRpcServer, stopRpcServer, discoverRpcServers } from '@/api/rpc-server'
import { cancel } from '@/api/cancel'
import { send, close } from '@/dispatch'
import { registerRpcServerProvider, hasRpcServerProvider } from '@/rpc/provider'
import { getAllPlugins } from '@/plugins/registry'
import {
  RpcServerOperationError,
  PluginsNotRegisteredError,
  InferenceCancelledError
} from '@/errors/index'
import { getRequestRegistry } from '@/runtime/request-context'
import { getRegisteredResourceCounts } from '@/runtime/runtime-lifecycle'
import { rpcServers } from '@/rpc/instance'
import type { RpcServerProvider } from '@/schemas/rpc-server'

function expectCancelled(t: ReturnType<typeof test>, promise: Promise<unknown>, requestId: string) {
  return promise.then(
    () => {
      t.fail('operation should reject on cancellation')
    },
    (error: unknown) => {
      t.ok(error instanceof InferenceCancelledError)
      if (error instanceof InferenceCancelledError) t.is(error.requestId, requestId)
    }
  )
}

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

test('public RPC discovery can be cancelled immediately without registered capabilities', async (t) => {
  try {
    t.is(getAllPlugins().length, 0)
    t.absent(hasRpcServerProvider())
    const search = discoverRpcServers({ topic: 'cancel-immediately', timeoutMs: 30000 })
    t.is(typeof search.requestId, 'string')
    const rejected = expectCancelled(t, search, search.requestId)
    await cancel({ requestId: search.requestId })
    await rejected
    t.is(getRequestRegistry().list().length, 0)
    t.is(getRegisteredResourceCounts().swarms, 0)
    await t.exception(send({ type: 'heartbeat' }), PluginsNotRegisteredError)
  } finally {
    await close()
  }
})

test('public RPC cancellation only aborts the selected discovery', async (t) => {
  try {
    const selected = discoverRpcServers({ topic: 'cancel-selected', timeoutMs: 30000 })
    const other = discoverRpcServers({ topic: 'keep-searching', timeoutMs: 100 })
    const rejected = expectCancelled(t, selected, selected.requestId)
    t.not(selected.requestId, other.requestId)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    t.ok(getRequestRegistry().get(selected.requestId), 'public ID identifies the running request')
    await cancel({ requestId: selected.requestId })
    await rejected
    t.alike(await other, [])
    await cancel({ requestId: other.requestId })
    t.is(getRequestRegistry().list().length, 0, 'cancel after completion is harmless')
    t.is(getRegisteredResourceCounts().swarms, 0)
  } finally {
    await close()
  }
})

test('public RPC start cancellation rolls back the handle when the provider returns', async (t) => {
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let stops = 0
  registerRpcServerProvider({
    async start(options) {
      t.absent('requestId' in options, 'cancellation metadata stays in the engine')
      started()
      await gate
      return {
        host: '127.0.0.1',
        port: 1,
        url: '127.0.0.1:1',
        runtime: 'in-process',
        rdmaCapable: false,
        async stop() {
          stops++
        }
      }
    }
  })
  try {
    const starting = startRpcServer()
    t.is(typeof starting.requestId, 'string')
    const rejected = expectCancelled(t, starting, starting.requestId)
    await entered
    await cancel({ requestId: starting.requestId })
    release()
    await rejected
    t.is(stops, 1, 'cancelled native handle is stopped before the call rejects')
    t.is(rpcServers.size, 0)
    t.is(getRequestRegistry().list().length, 0)
  } finally {
    release()
    await close()
  }
})

test('duplicate RPC request IDs do not remove the original request from shutdown tracking', async (t) => {
  try {
    const request = {
      type: 'discoverRpcServers',
      topic: 'duplicate',
      timeoutMs: 30000,
      requestId: 'duplicate-rpc-id'
    } as const
    const first = send(request)
    const rejected = expectCancelled(t, first, request.requestId)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await t.exception(send(request), /already/)
    await close()
    await rejected
    t.is(getRegisteredResourceCounts().swarms, 0)
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
