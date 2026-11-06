import test from 'brittle'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RpcServerOperationError } from '@/utils/errors-server'

process.env['QVAC_WORKER_PATH'] = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/rpc-status-worker.mjs'
)

test('RPC status crosses the worker boundary with identity, recovery and structured cause', async (t) => {
  t.timeout(15000)
  const { rpcServerStatusStream } = await import('@/client/api/rpc-server')
  const { close } = await import('@/client/rpc/rpc-client')
  const controller = new AbortController()
  const statuses = rpcServerStatusStream({}, { signal: controller.signal })
  try {
    let serverId: string | undefined
    let status
    while (true) {
      const next = await statuses.next()
      if (next.done) throw new Error('Status stream ended before failure')
      const update = next.value
      serverId ??= update.serverId
      t.is(update.serverId, serverId)
      if (update.advertisement === 'advertising') {
        t.ok(true, 'advertising starts before the injected failure')
      }
      if (update.advertisement === 'failed') {
        status = update
        break
      }
    }
    if (!status) throw new Error('Missing failed advertising status')
    t.ok(serverId)
    t.is(status.nativeState, 'owned')
    t.is(status.advertisement, 'failed')
    t.is(status.recovery, 'restart')
    t.ok(status.error instanceof RpcServerOperationError)
    const cause = status.error?.cause as {
      code: string
      message: string
      cause: { message: string }
    }
    t.is(cause.code, 'ENETDOWN')
    t.is(cause.message, 'UDP send failed')
    t.is(cause.cause.message, 'network removed')
    const pending = statuses.next()
    controller.abort()
    t.ok((await pending).done)
  } finally {
    controller.abort()
    await close()
  }
})
