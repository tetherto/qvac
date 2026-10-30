import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import type { EmbedRequest } from '@qvac/inference/surface'

let request: EmbedRequest | undefined
let options: unknown
let reply: unknown = {
  type: 'embed',
  success: true,
  embedding: [[0, 1]],
  stats: { totalTokens: 12 }
}
let failure: Error | undefined
mock.module('@/client/rpc/rpc-client', {
  namedExports: {
    send: async (input: EmbedRequest, opts: unknown) => {
      request = input
      options = opts
      if (failure) throw failure
      return reply
    }
  }
})
const { embed } = await import('@/client/api/embed')
const { summarizeRequest } = await import('@/logging/utils')

test('embed client preserves ordered media sources, requestId, stats and RPC options', async () => {
  const inputs = [
    'query',
    ['prefix', { media: { type: 'base64' as const, value: 'AQID' } }, 'suffix']
  ]
  const call = embed({ modelId: 'model', inputs }, { timeout: 1000 })
  assert.ok(call.requestId)
  assert.deepEqual(await call, { embedding: [[0, 1]], stats: { totalTokens: 12 } })
  assert.deepEqual(request, { type: 'embed', modelId: 'model', inputs, requestId: call.requestId })
  assert.deepEqual(options, { timeout: 1000 })
  assert.deepEqual(summarizeRequest(request!), {
    type: 'embed',
    modelId: 'model',
    inputs: '[2 embedding inputs]'
  })
})

test('embed client preserves native failures and rejects the wrong response type', async () => {
  failure = new Error('UnsupportedMedia')
  await assert.rejects(embed({ modelId: 'model', inputs: ['query'] }), failure)
  failure = undefined
  reply = { type: 'heartbeat' }
  await assert.rejects(embed({ modelId: 'model', inputs: ['query'] }), /embed/i)
})
