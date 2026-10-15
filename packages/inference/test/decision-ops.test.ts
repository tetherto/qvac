import test from 'brittle'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/request-context'
import { decide } from '@/plugins/builtin/llamacpp-decision/ops/decide'
import { ModelType, type DecisionResult } from '@/schemas/index'
import type { LayaResult } from '@qvac/embed-llamacpp'
import {
  InferenceCancelledError,
  RequestRejectedByPolicyError,
  InvalidResponseError
} from '@/errors/index'

const result: DecisionResult = {
  model: 'laya',
  answers: {
    refund: {
      type: 'noul',
      noul: 0.99,
      answerConfidence: 0.99,
      confidence: 0.99,
      action: { actProbability: 1 }
    }
  },
  usage: {
    inputTokens: 20,
    outputTokens: 0,
    stateTokens: 10,
    stateTokensDropped: 0,
    truncated: false,
    truncatedQuestions: [],
    options: { refund: { total: 2, distinct: 2, tokensPerOption: null } }
  }
}
const nativeResult: LayaResult = {
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
    truncated_questions: [],
    options: { refund: { total: 2, distinct: 2, tokens_per_option: null } }
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
    modelType: ModelType.llamacppDecision
  })
  t.teardown(() => {
    unregisterModel(id)
  })
}

test('decisions unwrap the addon response once and preserve single and batch results', async (t) => {
  let input: unknown
  fixture(t, 'decision-result', async (request) => {
    input = request
    return {
      await: async () => [
        request && typeof request === 'object' && 'states' in request
          ? [nativeResult, nativeResult]
          : nativeResult
      ]
    }
  })
  const single = await decide({
    type: 'decide',
    modelId: 'decision-result',
    requestId: 'decide-single',
    state: 'Refund',
    questions
  })
  t.alike(single.result, result)
  t.alike(input, { state: 'Refund', questions })
  const batch = await decide({
    type: 'decide',
    modelId: 'decision-result',
    states: ['a', 'b'],
    questions
  })
  t.alike(batch.result, [result, result])
  t.absent(getRequestRegistry().get('decide-single'))
})

test('decisions keep profiling metadata out of the native request', async (t) => {
  let input: unknown
  fixture(t, 'decision-profiled', async (request) => {
    input = request
    return { await: async () => [nativeResult] }
  })
  const request = {
    type: 'decide' as const,
    modelId: 'decision-profiled',
    state: 'Refund',
    questions,
    __profiling: { enabled: true, id: 'decision-profile' }
  }
  t.alike((await decide(request)).result, result)
  t.alike(input, { state: 'Refund', questions })
})

test('decisions omit undefined addon options while preserving explicit values', async (t) => {
  let input: unknown
  fixture(t, 'decision-options', async (request) => {
    input = request
    return {
      await: async () => [
        request && typeof request === 'object' && 'states' in request
          ? [nativeResult, nativeResult]
          : nativeResult
      ]
    }
  })
  const requestQuestions = {
    choice: {
      type: 'choice' as const,
      instructions: 'Which?',
      criteria: { a: null, b: false },
      optionOrder: undefined
    },
    score: {
      type: 'score' as const,
      instructions: 'How much?',
      criteria: [false, 0, ''],
      optionOrder: []
    },
    omitted: {
      type: 'noul' as const,
      instructions: 'Omitted?',
      optionOrder: undefined,
      criteria: undefined,
      labels: undefined
    },
    defaults: {
      type: 'noul' as const,
      instructions: 'Defaults?',
      criteria: null,
      labels: { false: '', true: 'yes' }
    },
    partial: {
      type: 'noul' as const,
      instructions: 'Partial?',
      criteria: { true: undefined, false: null },
      optionOrder: [1, 0]
    },
    empty: {
      type: 'noul' as const,
      instructions: 'Empty?',
      criteria: { true: undefined, false: undefined }
    }
  }
  const expectedQuestions = {
    choice: { type: 'choice', instructions: 'Which?', criteria: { a: null, b: false } },
    score: {
      type: 'score',
      instructions: 'How much?',
      criteria: [false, 0, ''],
      option_order: []
    },
    omitted: { type: 'noul', instructions: 'Omitted?' },
    defaults: {
      type: 'noul',
      instructions: 'Defaults?',
      criteria: null,
      labels: { false: '', true: 'yes' }
    },
    partial: {
      type: 'noul',
      instructions: 'Partial?',
      criteria: { false: null },
      option_order: [1, 0]
    },
    empty: { type: 'noul', instructions: 'Empty?', criteria: {} }
  }
  for (const state of [
    { state: { text: 'Refund', nested: [null, false, 0] } },
    { states: ['a', 'b'] }
  ]) {
    await decide({
      type: 'decide',
      modelId: 'decision-options',
      ...state,
      questions: requestQuestions,
      maxLen: undefined,
      headMaxLen: 128
    })
    t.alike(input, { ...state, questions: expectedQuestions, head_max_len: 128 })
    await decide({
      type: 'decide',
      modelId: 'decision-options',
      ...state,
      questions: requestQuestions,
      maxLen: 512,
      headMaxLen: undefined
    })
    t.alike(input, { ...state, questions: expectedQuestions, max_len: 512 })
  }
})

test('decisions reject malformed addon responses and release the model slot after failure', async (t) => {
  let output: unknown = []
  fixture(t, 'decision-invalid', async () => ({ await: async () => output }))
  const request = {
    type: 'decide' as const,
    modelId: 'decision-invalid',
    state: 'Refund',
    questions
  }
  await t.exception(() => decide(request), InvalidResponseError as unknown as new () => Error)
  output = [[nativeResult]]
  await t.exception(() => decide(request), InvalidResponseError as unknown as new () => Error)
  output = [nativeResult]
  t.alike((await decide(request)).result, result)
})

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

function gatedFixture(t: TestContext, id: string) {
  const starts: unknown[] = []
  let finish: () => void = () => {}
  let cancelled = 0
  fixture(
    t,
    id,
    async (input) => {
      starts.push(input)
      return {
        await: () =>
          new Promise<LayaResult[]>((resolve) => {
            finish = () => resolve([nativeResult])
          })
      }
    },
    async () => {
      cancelled++
      finish()
    }
  )
  return { starts, finish: () => finish(), cancelled: () => cancelled }
}

test('decisions queue FIFO per model and let another model run independently', async (t) => {
  const model = gatedFixture(t, 'decision-fifo')
  fixture(t, 'decision-independent', async () => ({ await: async () => [nativeResult] }))
  const request = { type: 'decide' as const, modelId: 'decision-fifo', questions }
  const first = decide({ ...request, state: 'first' })
  await settle()
  const second = decide({ ...request, state: 'second' })
  const third = decide({ ...request, state: 'third' })
  await settle()
  t.alike(model.starts, [{ state: 'first', questions }])
  t.alike(
    (await decide({ ...request, modelId: 'decision-independent', state: 'other' })).result,
    result
  )
  model.finish()
  await first
  await settle()
  t.alike(model.starts, [
    { state: 'first', questions },
    { state: 'second', questions }
  ])
  model.finish()
  await second
  await settle()
  t.alike(model.starts, [
    { state: 'first', questions },
    { state: 'second', questions },
    { state: 'third', questions }
  ])
  model.finish()
  t.alike((await third).result, result)
})

test('cancelling a queued decision never starts or cancels native work', async (t) => {
  const model = gatedFixture(t, 'decision-queued-cancel')
  const request = {
    type: 'decide' as const,
    modelId: 'decision-queued-cancel',
    state: 'Refund',
    questions
  }
  const first = decide({ ...request, requestId: 'decision-queue-holder' })
  await settle()
  const queued = decide({ ...request, requestId: 'decision-queue-cancelled' })
  const failure = t.exception(() => queued, InferenceCancelledError as unknown as new () => Error)
  await settle()
  t.is(getRequestRegistry().cancel({ requestId: 'decision-queue-cancelled' }), 1)
  await failure
  t.is(model.starts.length, 1)
  t.is(model.cancelled(), 0)
  t.absent(getRequestRegistry().get('decision-queue-cancelled'))
  model.finish()
  t.alike((await first).result, result)
})

test('decisions bound the waiting queue without interrupting admitted requests', async (t) => {
  let starts = 0
  let finish: () => void = () => {}
  let cancelled = 0
  fixture(
    t,
    'decision-overflow',
    async () => {
      starts++
      return {
        await: () =>
          starts === 1
            ? new Promise<LayaResult[]>((resolve) => {
                finish = () => resolve([nativeResult])
              })
            : Promise.resolve([nativeResult])
      }
    },
    async () => {
      cancelled++
    }
  )
  const request = {
    type: 'decide' as const,
    modelId: 'decision-overflow',
    state: 'Refund',
    questions
  }
  const first = decide(request)
  await settle()
  const queued = Array.from({ length: 64 }, () => decide(request))
  await t.exception(
    () => decide(request),
    RequestRejectedByPolicyError as unknown as new () => Error
  )
  t.is(starts, 1)
  t.is(cancelled, 0)
  finish()
  const responses = await Promise.all([first, ...queued])
  t.is(responses.length, 65)
  t.is(starts, 65)
  t.alike(
    responses.map((response) => response.result),
    Array.from({ length: 65 }, () => result)
  )
  t.alike((await decide(request)).result, result)
})

test('decisions cancel the owning job, admit the next queued call, and allow recovery', async (t) => {
  let finish: (value: LayaResult[]) => void = () => {}
  let started: () => void = () => {}
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  let cancelled = 0
  fixture(
    t,
    'decision-cancel',
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
      finish([nativeResult])
    }
  )
  const request = {
    type: 'decide' as const,
    modelId: 'decision-cancel',
    state: 'Refund',
    questions
  }
  const first = decide({ ...request, requestId: 'decide-cancel' })
  const failure = t.exception(() => first, InferenceCancelledError as unknown as new () => Error)
  await running
  const queued = decide({ ...request, requestId: 'decide-next' })
  await settle()
  t.is(cancelled, 0)
  getRequestRegistry().cancel({ requestId: 'decide-cancel' })
  await failure
  t.is(cancelled, 1)
  t.absent(getRequestRegistry().get('decide-cancel'))
  await settle()
  finish([nativeResult])
  t.alike((await queued).result, result)
  const recovered = decide(request)
  await new Promise<void>((resolve) => setTimeout(resolve, 0, undefined))
  finish([nativeResult])
  t.alike((await recovered).result, result)
})

test('decisions hold the model slot until pending native cancellation settles', async (t) => {
  let finishOutput: (value: LayaResult[]) => void = () => {}
  let rejectOutput: (error: Error) => void = () => {}
  let finishCancel: () => void = () => {}
  const cancellation = new Promise<void>((resolve) => {
    finishCancel = resolve
  })
  let notifyFirst: () => void = () => {}
  let notifyNext: () => void = () => {}
  const firstStarted = new Promise<void>((resolve) => {
    notifyFirst = resolve
  })
  const nextStarted = new Promise<void>((resolve) => {
    notifyNext = resolve
  })
  let starts = 0
  let cancelled = 0
  fixture(
    t,
    'decision-pending-cancel',
    async () => ({
      await: () =>
        new Promise<LayaResult[]>((resolve, reject) => {
          finishOutput = resolve
          rejectOutput = reject
          starts++
          if (starts === 1) notifyFirst()
          else notifyNext()
        })
    }),
    async () => {
      cancelled++
      await cancellation
      // Native cancellation targets whichever job occupies the single model slot.
      rejectOutput(new Error('Delayed cancellation reached the current job'))
    }
  )
  const request = {
    type: 'decide' as const,
    modelId: 'decision-pending-cancel',
    state: 'Refund',
    questions
  }
  const first = decide({ ...request, requestId: 'decision-pending-cancel-first' })
  const failure = t.exception(() => first, InferenceCancelledError as unknown as new () => Error)
  await firstStarted
  const queued = decide({ ...request, requestId: 'decision-pending-cancel-next' }).then(
    (response) => ({ result: response.result }),
    (error: unknown) => ({ error })
  )
  t.is(getRequestRegistry().cancel({ requestId: 'decision-pending-cancel-first' }), 1)
  t.is(cancelled, 1)
  // The first job finishes naturally while its cancellation is still pending.
  finishOutput([nativeResult])
  await settle()
  t.is(starts, 1, 'the queued job cannot start while native cancellation is pending')
  finishCancel()
  await failure
  await nextStarted
  finishOutput([nativeResult])
  t.alike(await queued, { result }, 'the delayed cancellation cannot abort the queued job')
  t.absent(getRequestRegistry().get('decision-pending-cancel-first'))
  t.absent(getRequestRegistry().get('decision-pending-cancel-next'))
})

test('cancel-before-begin never starts native work', async (t) => {
  let starts = 0
  fixture(t, 'decision-pre-cancel', async () => {
    starts++
    return { await: async () => [nativeResult] }
  })
  getRequestRegistry().cancel({ requestId: 'decide-pre-cancel' })
  await t.exception(
    () =>
      decide({
        type: 'decide',
        modelId: 'decision-pre-cancel',
        requestId: 'decide-pre-cancel',
        state: 'Refund',
        questions
      }),
    InferenceCancelledError as unknown as new () => Error
  )
  t.is(starts, 0)
})
