import test from 'brittle'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/request-context'
import { decide } from '@/plugins/builtin/llamacpp-decision/ops/decide'
import type {
  UpstreamDecisionInfo,
  UpstreamResult
} from '@/plugins/builtin/llamacpp-decision/upstream'
import { ModelType, type DecisionResult } from '@/schemas/index'
import {
  InferenceCancelledError,
  RequestRejectedByPolicyError,
  InvalidResponseError
} from '@/errors/index'

const result: DecisionResult = {
  model: 'laya',
  answers: { refund: { type: 'noul', noul: 0.99, confidence: 0.99 } },
  usage: { inputTokens: 20, outputTokens: 0 }
}
const nativeResult: UpstreamResult = {
  model: 'laya',
  answers: { refund: { type: 'noul', noul: 0.99, confidence: 0.99 } },
  usage: { input_tokens: 20, output_tokens: 0 }
}
const info: UpstreamDecisionInfo = {
  decision_type: 'laya',
  noul: 'probability',
  joint: false,
  shared_prefix: false,
  images: false,
  audio: false,
  score_levels: { min: 2, max: 10 },
  max_json_depth: 128,
  n_ctx: 512,
  model: 'laya'
}
// A noul question without criteria converts to itself.
const questions = { refund: { type: 'noul' as const, instructions: 'Refund requested.' } }

type TestContext = { teardown(cleanup: () => void): void }

/** Registers a DecisionModel stand-in whose engine runs `run` for each state. */
function fixture(
  t: TestContext,
  id: string,
  run: (request: unknown) => Promise<unknown>,
  cancel = async () => {}
) {
  registerModel(id, {
    model: { info, engine: { run }, cancel } as unknown as AnyModel,
    path: '/tmp/decision.gguf',
    config: {},
    modelType: ModelType.llamacppDecision
  })
  t.teardown(() => {
    unregisterModel(id)
  })
}

test('decisions unwrap each engine response and preserve single and batch results', async (t) => {
  const inputs: unknown[] = []
  fixture(t, 'decision-result', async (request) => {
    inputs.push(request)
    return { await: async () => [nativeResult] }
  })
  const single = await decide({
    type: 'decide',
    modelId: 'decision-result',
    requestId: 'decide-single',
    state: 'Refund',
    questions
  })
  t.alike(single.result, result)
  t.alike(inputs, [{ state: 'Refund', questions }])
  const batch = await decide({
    type: 'decide',
    modelId: 'decision-result',
    states: ['a', 'b'],
    questions
  })
  t.alike(batch.result, [result, result])
  t.alike(inputs.slice(1), [
    { state: 'a', questions },
    { state: 'b', questions }
  ], 'one engine run per state, in input order')
  t.absent(getRequestRegistry().get('decide-single'))
})

test('decisions keep profiling metadata out of the engine request', async (t) => {
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

test('decisions pass criteria through and omit undefined values', async (t) => {
  const inputs: unknown[] = []
  fixture(t, 'decision-criteria', async (request) => {
    inputs.push(request)
    return { await: async () => [nativeResult] }
  })
  const requestQuestions = {
    choice: { type: 'choice' as const, instructions: 'Which?', criteria: { a: null, b: false } },
    score: { type: 'score' as const, instructions: 'How much?', criteria: [false, 0, ''] },
    omitted: { type: 'noul' as const, instructions: 'Omitted?', criteria: undefined },
    nulled: { type: 'noul' as const, instructions: 'Null?', criteria: null },
    partial: {
      type: 'noul' as const,
      instructions: 'Partial?',
      criteria: { true: undefined, false: null }
    },
    empty: {
      type: 'noul' as const,
      instructions: 'Empty?',
      criteria: { true: undefined, false: undefined }
    }
  }
  const expectedQuestions = {
    choice: { type: 'choice', instructions: 'Which?', criteria: { a: null, b: false } },
    score: { type: 'score', instructions: 'How much?', criteria: [false, 0, ''] },
    omitted: { type: 'noul', instructions: 'Omitted?' },
    nulled: { type: 'noul', instructions: 'Null?' },
    partial: { type: 'noul', instructions: 'Partial?', criteria: { false: null } },
    empty: { type: 'noul', instructions: 'Empty?', criteria: {} }
  }
  const state = { text: 'Refund', nested: [null, false, 0] }
  await decide({ type: 'decide', modelId: 'decision-criteria', state, questions: requestQuestions })
  await decide({
    type: 'decide',
    modelId: 'decision-criteria',
    states: ['a', 'b'],
    questions: requestQuestions
  })
  t.alike(inputs, [
    { state, questions: expectedQuestions },
    { state: 'a', questions: expectedQuestions },
    { state: 'b', questions: expectedQuestions }
  ])
})

test('decisions reject malformed engine responses and release the model slot after failure', async (t) => {
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
          new Promise<UpstreamResult[]>((resolve) => {
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
            ? new Promise<UpstreamResult[]>((resolve) => {
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
  let finish: (value: UpstreamResult[]) => void = () => {}
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
        return new Promise<UpstreamResult[]>((resolve) => {
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
  let finishOutput: (value: UpstreamResult[]) => void = () => {}
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
        new Promise<UpstreamResult[]>((resolve, reject) => {
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
