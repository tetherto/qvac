import test from 'brittle'
import AbortController from 'bare-abort-controller'
import { handleRpcServerStatusStream } from '@/handlers/rpc-server'
import type { RpcServerStatus } from '@/schemas/rpc-server'

const status: RpcServerStatus = {
  serverId: 'owned',
  url: '10.0.0.2:50052',
  nativeState: 'owned',
  advertisement: 'advertising',
  reason: 'Advertising is active',
  recovery: 'none'
}
function source() {
  const listeners = new Set<(status: RpcServerStatus) => void>()
  return {
    listeners,
    subscribe(listener: (status: RpcServerStatus) => void) {
      listeners.add(listener)
      listener(status)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(update: RpcServerStatus) {
      for (const listener of listeners) listener(update)
    }
  }
}

test('RPC status handler sends snapshot and matching updates, then aborts a quiet subscription', async (t) => {
  const manager = source()
  const controller = new AbortController()
  const stream = handleRpcServerStatusStream(
    { type: 'rpcServerStatusStream', serverId: 'owned' },
    { signal: controller.signal },
    manager
  )
  t.alike((await stream.next()).value, { ...status, type: 'rpcServerStatusStream' })
  const pending = stream.next()
  manager.emit({ ...status, serverId: 'other' })
  manager.emit({ ...status, advertisement: 'suspended', recovery: 'resume' })
  t.is((await pending).value?.advertisement, 'suspended')
  const quiet = stream.next()
  controller.abort(undefined)
  t.ok((await quiet).done)
  t.is(manager.listeners.size, 0)
})

test('RPC status handler reports overflow while paused at a yield and releases subscription', async (t) => {
  const manager = source()
  const stream = handleRpcServerStatusStream({ type: 'rpcServerStatusStream' }, {}, manager)
  await stream.next()
  for (let i = 0; i < 257; i++) manager.emit(status)
  await t.exception(stream.next(), /exceeded 256/)
  t.is(manager.listeners.size, 0)
})
