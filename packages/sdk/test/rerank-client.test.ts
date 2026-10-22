import test from 'brittle'
import { createRerankCall } from '@/client/api/rerank'
import { InferenceCancelledError } from '@/utils/errors-server'
import { InvalidResponseError, RequestValidationFailedError } from '@/utils/errors-client'
import type { RerankRequest } from '@qvac/inference/surface'

const params = {
  modelId: 'reranker',
  query: 'How do I get a refund?',
  documents: ['Refunds take 5 days.', 'The office opens at 9am.']
}

test('rerank client exposes requestId synchronously and returns scores in document order', async (t) => {
  let request: RerankRequest | undefined
  let options: unknown
  const send = async (input: RerankRequest, opts: unknown) => {
    request = input
    options = opts
    return { type: 'rerank', scores: [4.25, -3.5] }
  }
  const call = createRerankCall(params, { timeout: 1000 }, send as never)
  t.ok(call.requestId)
  t.alike(await call, [4.25, -3.5])
  t.alike(request, { ...params, type: 'rerank', requestId: call.requestId })
  t.alike(options, { timeout: 1000 })
})

test('rerank client rejects input before RPC and rejects malformed or mismatched replies', async (t) => {
  let sends = 0
  const send = async () => {
    sends++
    return { type: 'rerank', scores: [1, 2] }
  }
  for (const input of [
    { ...params, query: '' },
    { ...params, documents: [] },
    { ...params, documents: [1] },
    { ...params, topN: 1 }
  ]) {
    await t.exception(
      createRerankCall(input as never, undefined, send as never),
      RequestValidationFailedError as unknown as new () => Error
    )
  }
  t.is(sends, 0)
  for (const reply of [
    { type: 'embed' },
    { type: 'rerank', scores: [1] },
    { type: 'rerank', scores: [1, 2, 3] },
    { type: 'rerank', scores: [1, Number.NaN] },
    { type: 'rerank', scores: '1,2' }
  ]) {
    await t.exception(
      createRerankCall(params, undefined, (async () => reply) as never),
      InvalidResponseError as unknown as new () => Error
    )
  }
})

test('rerank client preserves cancellation and native failures', async (t) => {
  for (const failure of [
    new InferenceCancelledError('rerank-cancel'),
    new Error('Native decode failed')
  ]) {
    try {
      await createRerankCall(params, undefined, (async () => {
        throw failure
      }) as never)
      t.fail('The transport failure must reject')
    } catch (error) {
      t.is(error, failure)
    }
  }
})
