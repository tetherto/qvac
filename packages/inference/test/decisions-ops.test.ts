import test from 'brittle'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/request-context'
import { decide } from '@/plugins/builtin/llamacpp-decisions/ops/decide'
import { ModelType, type LayaResult } from '@/schemas/index'
import {
  InferenceCancelledError,
  RequestRejectedByPolicyError,
  InvalidResponseError
} from '@/errors/index'

const result: LayaResult = {
  model: 'laya',
  answers: {
    refund: {
      type: 'noul',
      noul: 0.99,
      answer_confidence: 0.99,
      confidence: 0.99,
      action: { act_probability: 1 }
    }
  },
  usage: {
    input_tokens: 20,
    output_tokens: 0,
    state_tokens: 10,
    state_tokens_dropped: 0,
    truncated: false,
    truncated_questions: []
  }
}
const questions = { refund: { type: 'noul' as const, instructions: 'Refund requested.' } }

type TestContext = { teardown(cleanup: () => void): void }

function fixture(
  t: TestContext,
  id: string,
  run: (request: unknown) => Promise<unknown>,
  cancel = async () => {}
) {
  registerModel(id, {
    model: { run, cancel } as unknown as AnyModel,
    path: '/tmp/laya.gguf',
    config: {},
    modelType: ModelType.llamacppDecisions
  })
  t.teardown(() => {
    unregisterModel(id)
  })
}

test('decisions unwrap the addon response once and preserve single and batch results', async (t) => {
  let input: unknown
  fixture(t, 'decisions-result', async (request) => {
    input = request
    return {
      await: async () => [
        request && typeof request === 'object' && 'states' in request ? [result, result] : result
      ]
    }
  })
  const single = await decide({
    type: 'decide',
    modelId: 'decisions-result',
    requestId: 'decide-single',
    state: 'Refund',
    questions
  })
  t.alike(single.result, result)
  t.alike(input, { state: 'Refund', questions })
  const batch = await decide({
    type: 'decide',
    modelId: 'decisions-result',
    states: ['a', 'b'],
    questions
  })
  t.alike(batch.result, [result, result])
  t.absent(getRequestRegistry().get('decide-single'))
})

test('decisions reject malformed addon responses and release the model slot after failure', async (t) => {
  let output: unknown = []
  fixture(t, 'decisions-invalid', async () => ({ await: async () => output }))
  const request = {
    type: 'decide' as const,
    modelId: 'decisions-invalid',
    state: 'Refund',
    questions
  }
  await t.exception(() => decide(request), InvalidResponseError as unknown as new () => Error)
  output = [[result]]
  await t.exception(() => decide(request), InvalidResponseError as unknown as new () => Error)
  output = [result]
  t.alike((await decide(request)).result, result)
})

test('decisions cancel the owning job, reject concurrent calls, and allow recovery', async (t) => {
  let finish: (value: LayaResult[]) => void = () => {}
  let started: () => void = () => {}
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  let cancelled = 0
  fixture(
    t,
    'decisions-cancel',
    async () => ({
      await: () => {
        started()
        return new Promise<LayaResult[]>((resolve) => {
          finish = resolve
        })
      }
    }),
    async () => {
      cancelled++
      finish([result])
    }
  )
  const request = {
    type: 'decide' as const,
    modelId: 'decisions-cancel',
    state: 'Refund',
    questions
  }
  const first = decide({ ...request, requestId: 'decide-cancel' })
  const failure = t.exception(() => first, InferenceCancelledError as unknown as new () => Error)
  await running
  await t.exception(
    () => decide({ ...request, requestId: 'decide-busy' }),
    RequestRejectedByPolicyError as unknown as new () => Error
  )
  getRequestRegistry().cancel({ requestId: 'decide-cancel' })
  await failure
  t.is(cancelled, 1)
  t.absent(getRequestRegistry().get('decide-cancel'))
  const recovered = decide(request)
  await new Promise<void>((resolve) => setTimeout(resolve, 0, undefined))
  finish([result])
  t.alike((await recovered).result, result)
})

test('cancel-before-begin never starts native work', async (t) => {
  let starts = 0
  fixture(t, 'decisions-pre-cancel', async () => {
    starts++
    return { await: async () => [result] }
  })
  getRequestRegistry().cancel({ requestId: 'decide-pre-cancel' })
  await t.exception(
    () =>
      decide({
        type: 'decide',
        modelId: 'decisions-pre-cancel',
        requestId: 'decide-pre-cancel',
        state: 'Refund',
        questions
      }),
    InferenceCancelledError as unknown as new () => Error
  )
  t.is(starts, 0)
})
