import test from 'brittle'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  startRpcServerOptionsSchema,
  discoverRpcServersOptionsSchema
} from '@qvac/inference/surface'

process.env['QVAC_WORKER_PATH'] = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/rpc-options-worker.mjs'
)

test('RPC SDK forwards explicit addresses for both serving and lookup across its worker boundary', async (t) => {
  t.timeout(15000)
  const { startRpcServer, discoverRpcServers } = await import('@/client/api/rpc-server')
  const { close } = await import('@/client/rpc/rpc-client')
  const lanAddresses = ['10.0.0.2', '192.168.1.2']
  try {
    const options = {
      host: '10.0.0.2',
      allowNonLoopbackHost: true,
      discoveryTopic: 'shared',
      lanAddresses
    }
    const server = await startRpcServer(options)
    const request = JSON.parse(server.serverId)
    t.alike(request.lanAddresses, lanAddresses)
    t.is(request.host, options.host)
    t.is(request.discoveryTopic, 'shared')
    const candidates = await discoverRpcServers({ topic: 'shared', lanAddresses, timeoutMs: 100 })
    t.alike(
      candidates.map(({ url }) => url),
      lanAddresses.map((address) => `${address}:50052`)
    )
  } finally {
    await close()
  }
})

test('RPC SDK shared schemas reject invalid selection shape and preserve valid selection', (t) => {
  for (const schema of [startRpcServerOptionsSchema, discoverRpcServersOptionsSchema]) {
    const value = schema.parse({ topic: 'shared', lanAddresses: ['10.0.0.2'] })
    t.alike(value.lanAddresses, ['10.0.0.2'])
    for (const lanAddresses of [[], ['10.0.0.2', '10.0.0.2'], ['127.0.0.1'], ['10.0.0.999']]) {
      t.absent(schema.safeParse({ topic: 'shared', lanAddresses }).success)
    }
  }
})
