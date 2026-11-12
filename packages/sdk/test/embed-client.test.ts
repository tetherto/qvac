import { beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Request } from '@qvac/inference/surface'

const success = {
  type: 'embed',
  success: true,
  embedding: [[0, 1]],
  stats: { totalTokens: 12 }
}
const send = mock.fn(async (_input: Request, _opts?: unknown): Promise<unknown> => success)
mock.module('@/client/rpc/rpc-client', { namedExports: { send } })
const { embed, embedBatch } = await import('@/client/api/embed')
const { summarizeRequest } = await import('@/logging/utils')
const { getClientLogger } = await import('@/logging')
const warn = mock.method(getClientLogger(), 'warn', () => {})

beforeEach(() => {
  send.mock.resetCalls()
  warn.mock.resetCalls()
})

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

test('only the legacy batch forms of embed warn about deprecation', async () => {
  await embed({ modelId: 'model', text: ['a', 'b'] })
  await embed({ modelId: 'model', inputs: ['a'] })
  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments[0]),
    [
      'embed() with a text array is deprecated. Use embedBatch() instead.',
      'embed() with inputs is deprecated. Use embedBatch() instead.'
    ]
  )
  warn.mock.resetCalls()
  send.mock.mockImplementation(async () => ({ type: 'embed', success: true, embedding: [0, 1] }))
  await embed({ modelId: 'model', text: 'a' })
  await embed({ modelId: 'model', input: 'a' })
  send.mock.mockImplementation(async () => ({ ...success, type: 'embedBatch' }))
  await embedBatch({ modelId: 'model', inputs: ['a'] })
  send.mock.mockImplementation(async () => success)
  assert.equal(warn.mock.callCount(), 0)
})

test('embed single image encodes bytes and preserves image statistics', async () => {
  send.mock.mockImplementationOnce(async () => ({
    type: 'embed',
    success: true,
    embedding: [0, 1],
    stats: { backendId: 1, weightBytes: 10 }
  }))
  const call = embed({
    modelId: 'model',
    input: { image: new Uint8Array([1, 2, 3]), width: 1, height: 1, channels: 3 }
  })
  assert.ok(call.requestId)
  assert.deepEqual(await call, { embedding: [0, 1], stats: { backendId: 1, weightBytes: 10 } })
  assert.deepEqual(send.mock.calls[0]!.arguments[0], {
    type: 'embed',
    modelId: 'model',
    input: { image: 'AQID', width: 1, height: 1, channels: 3 },
    requestId: call.requestId
  })
})

test('embedBatch preserves input order, bytes, one-item batches and options', async () => {
  const inputs = [
    'text',
    [{ media: { type: 'base64' as const, value: 'AQID' } }],
    { image: new Uint8Array([4, 5, 6]) }
  ]
  send.mock.mockImplementationOnce(async () => ({
    type: 'embedBatch',
    success: true,
    embedding: [[1], [2], [3]],
    stats: { totalTime: 12 }
  }))
  const call = embedBatch({ modelId: 'model', inputs }, { timeout: 1000 })
  assert.ok(call.requestId)
  assert.deepEqual(await call, { embedding: [[1], [2], [3]], stats: { totalTime: 12 } })
  assert.deepEqual(send.mock.calls[0]!.arguments, [
    {
      type: 'embedBatch',
      modelId: 'model',
      inputs: ['text', inputs[1], { image: 'BAUG' }],
      requestId: call.requestId
    },
    { timeout: 1000 }
  ])
  send.mock.mockImplementationOnce(async () => ({
    type: 'embedBatch',
    success: true,
    embedding: [[0, 1]]
  }))
  assert.deepEqual(await embedBatch({ modelId: 'model', inputs: ['one'] }), { embedding: [[0, 1]] })
})

test('embedding clients reject invalid or ambiguous inputs before RPC', async () => {
  for (const params of [
    { input: '' },
    { input: [] },
    { input: 'query', text: 'query' },
    { input: { image: new Uint8Array() } },
    { input: { image: new Uint8Array([1]), width: 1, height: 1, channels: 3 } }
  ]) {
    await assert.rejects(embed({ modelId: 'model', ...params } as never), /./)
  }
  await assert.rejects(embedBatch({ modelId: 'model', inputs: [] }), /Inputs cannot be empty/)
  assert.equal(send.mock.callCount(), 0)
})

test('embedBatch preserves failures and rejects single-vector or wrong replies', async () => {
  const failure = new Error('cancelled')
  send.mock.mockImplementationOnce(async () => {
    throw failure
  })
  await assert.rejects(embedBatch({ modelId: 'model', inputs: ['query'] }), failure)
  for (const reply of [
    { type: 'embed', success: true, embedding: [[0, 1]] },
    { type: 'embedBatch', success: true, embedding: [0, 1] }
  ]) {
    send.mock.mockImplementationOnce(async () => reply)
    await assert.rejects(embedBatch({ modelId: 'model', inputs: ['query'] }), /embedBatch/i)
  }
})
