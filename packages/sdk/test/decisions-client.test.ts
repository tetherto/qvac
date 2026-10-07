import test from 'brittle'
import { createDecisionsCall } from '@/client/api/decide'
import { InferenceCancelledError } from '@/utils/errors-server'
import { InvalidResponseError, RequestValidationFailedError } from '@/utils/errors-client'
import type { DecideRequest, LayaResult } from '@qvac/inference/surface'

const result: LayaResult = {
  model: 'laya',
  answers: {},
  usage: {
    input_tokens: 1,
    output_tokens: 0,
    state_tokens: 1,
    state_tokens_dropped: 0,
    truncated: false,
    truncated_questions: []
  }
}
const params = {
  modelId: 'laya',
  state: 'Refund',
  questions: { refund: { type: 'noul' as const, instructions: 'Refund requested.' } }
}

test('decide client exposes requestId synchronously and preserves batch shape over RPC', async (t) => {
  let request: DecideRequest | undefined
  let options: unknown
  const send = async (input: DecideRequest, opts: unknown) => {
    request = input
    options = opts
    return { type: 'decide', result: 'states' in input ? [result, result] : result }
  }
  const call = createDecisionsCall(params, { timeout: 1000 }, send as never)
  t.ok(call.requestId)
  t.alike(await call, result)
  t.is(request?.requestId, call.requestId)
  t.alike(options, { timeout: 1000 })
  const { state, ...batch } = params
  t.alike(
    await createDecisionsCall({ ...batch, states: [state, state] }, undefined, send as never),
    [result, result]
  )
})

test('decide client rejects input before RPC and rejects malformed or mismatched replies', async (t) => {
  let sends = 0
  const send = async () => {
    sends++
    return { type: 'decide', result }
  }
  await t.exception(
    createDecisionsCall({ ...params, max_len: -1 }, undefined, send as never),
    RequestValidationFailedError as unknown as new () => Error
  )
  t.is(sends, 0)
  for (const reply of [
    { type: 'embed' },
    { type: 'decide', result: [] },
    { type: 'decide', result: {} }
  ]) {
    await t.exception(
      createDecisionsCall(params, undefined, (async () => reply) as never),
      InvalidResponseError as unknown as new () => Error
    )
  }
  const { state, ...batch } = params
  await t.exception(
    createDecisionsCall({ ...batch, states: [state] }, undefined, (async () => ({
      type: 'decide',
      result: []
    })) as never),
    InvalidResponseError as unknown as new () => Error
  )
})

test('decide client preserves cancellation and native failures', async (t) => {
  for (const failure of [
    new InferenceCancelledError('decide-cancel'),
    new Error('Native decode failed')
  ]) {
    try {
      await createDecisionsCall(params, undefined, (async () => {
        throw failure
      }) as never)
      t.fail('The transport failure must reject')
    } catch (error) {
      t.is(error, failure)
    }
  }
  try {
    await createDecisionsCall({ ...params, max_len: -1 }, undefined, (async () => {}) as never)
  } catch (error) {
    t.ok(error instanceof RequestValidationFailedError)
  }
})
