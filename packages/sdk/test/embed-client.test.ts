import { beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import type { EmbedRequest } from '@qvac/inference/surface'

const success = {
  type: 'embed',
  success: true,
  embedding: [[0, 1]],
  stats: { totalTokens: 12 }
}
const send = mock.fn(async (_input: EmbedRequest, _opts?: unknown): Promise<unknown> => success)
mock.module('@/client/rpc/rpc-client', { namedExports: { send } })
const { embed } = await import('@/client/api/embed')
const { summarizeRequest } = await import('@/logging/utils')

beforeEach(() => send.mock.resetCalls())

test('embed client preserves ordered media sources, requestId, stats and RPC options', async () => {
  const inputs = [
    'query',
    ['prefix', { media: { type: 'base64' as const, value: 'AQID' } }, 'suffix']
  ]
  const call = embed({ modelId: 'model', inputs }, { timeout: 1000 })
  assert.ok(call.requestId)
  assert.deepEqual(await call, { embedding: [[0, 1]], stats: { totalTokens: 12 } })
  assert.equal(send.mock.callCount(), 1)
  const [request, options] = send.mock.calls[0]!.arguments
  assert.deepEqual(request, { type: 'embed', modelId: 'model', inputs, requestId: call.requestId })
  assert.deepEqual(options, { timeout: 1000 })
  assert.deepEqual(summarizeRequest(request), {
    type: 'embed',
    modelId: 'model',
    inputs: '[2 embedding inputs]'
  })
})

test('embed client preserves native failures and rejects the wrong response type', async () => {
  const failure = new Error('UnsupportedMedia')
  send.mock.mockImplementationOnce(async () => {
    throw failure
  })
  await assert.rejects(embed({ modelId: 'model', inputs: ['query'] }), failure)
  send.mock.mockImplementationOnce(async () => ({ type: 'heartbeat' }))
  await assert.rejects(embed({ modelId: 'model', inputs: ['query'] }), /embed/i)
})
