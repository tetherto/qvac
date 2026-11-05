import test from 'brittle'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/request-context'
import { rerank } from '@/plugins/builtin/llamacpp-rerank/ops/rerank'
import { ModelType } from '@/schemas/index'
import type { RerankScores } from '@qvac/embed-llamacpp'
import {
  InferenceCancelledError,
  RequestRejectedByPolicyError,
  InvalidResponseError
} from '@/errors/index'

const query = 'How do I get a refund?'
const documents = ['Refunds take 5 days.', 'The office opens at 9am.']
const scores: RerankScores = [4.25, -3.5]

type TestContext = { teardown(cleanup: () => void): void }

function fixture(
  t: TestContext,
  id: string,
  run: (request: unknown) => Promise<unknown>,
  cancel = async () => {}
) {
  registerModel(id, {
    model: { run, cancel } as unknown as AnyModel,
    path: '/tmp/reranker.gguf',
    config: {},
    modelType: ModelType.llamacppRerank
  })
  t.teardown(() => {
    unregisterModel(id)
  })
}

test('rerank unwraps the addon response once and keeps scores in document order', async (t) => {
  let input: unknown
  fixture(t, 'rerank-result', async (request) => {
    input = request
    return { await: async () => [scores] }
  })
  const response = await rerank({
    type: 'rerank',
    modelId: 'rerank-result',
    requestId: 'rerank-single',
    query,
    documents
  })
  t.alike(response.scores, scores)
  t.alike(input, { query, documents })
  t.absent(getRequestRegistry().get('rerank-single'))
})

test('rerank keeps profiling metadata out of the native request', async (t) => {
  let input: unknown
  fixture(t, 'rerank-profiled', async (request) => {
    input = request
    return { await: async () => [scores] }
  })
  const request = {
    type: 'rerank' as const,
    modelId: 'rerank-profiled',
    query,
    documents,
    __profiling: { enabled: true, id: 'rerank-profile' }
  }
  t.alike((await rerank(request)).scores, scores)
  t.alike(input, { query, documents })
})

test('rerank rejects malformed addon responses and releases the model slot after failure', async (t) => {
  let output: unknown = []
  fixture(t, 'rerank-invalid', async () => ({ await: async () => output }))
  const request = { type: 'rerank' as const, modelId: 'rerank-invalid', query, documents }
  for (const malformed of [
    [],
    [scores, scores],
    [[4.25]],
    [[4.25, -3.5, 1]],
    [[4.25, Number.NaN]],
    [[Number.POSITIVE_INFINITY, -3.5]],
    [['4.25', -3.5]]
  ]) {
    output = malformed
    await t.exception(() => rerank(request), InvalidResponseError as unknown as new () => Error)
  }
  output = [scores]
  t.alike((await rerank(request)).scores, scores)
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
          new Promise<RerankScores[]>((resolve) => {
            finish = () => resolve([scores])
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

test('rerank queues FIFO per model and lets another model run independently', async (t) => {
  const model = gatedFixture(t, 'rerank-fifo')
  fixture(t, 'rerank-independent', async () => ({ await: async () => [scores] }))
  const request = { type: 'rerank' as const, modelId: 'rerank-fifo', documents }
  const first = rerank({ ...request, query: 'first' })
  await settle()
  const second = rerank({ ...request, query: 'second' })
  const third = rerank({ ...request, query: 'third' })
  await settle()
  t.alike(model.starts, [{ query: 'first', documents }])
  t.alike(
    (await rerank({ ...request, modelId: 'rerank-independent', query: 'other' })).scores,
    scores
  )
  model.finish()
  await first
  await settle()
  t.alike(model.starts, [
    { query: 'first', documents },
    { query: 'second', documents }
  ])
  model.finish()
  await second
  await settle()
  t.alike(model.starts, [
    { query: 'first', documents },
    { query: 'second', documents },
    { query: 'third', documents }
  ])
  model.finish()
  t.alike((await third).scores, scores)
})

test('cancelling a queued rerank never starts or cancels native work', async (t) => {
  const model = gatedFixture(t, 'rerank-queued-cancel')
  const request = { type: 'rerank' as const, modelId: 'rerank-queued-cancel', query, documents }
  const first = rerank({ ...request, requestId: 'rerank-queue-holder' })
  await settle()
  const queued = rerank({ ...request, requestId: 'rerank-queue-cancelled' })
  const failure = t.exception(() => queued, InferenceCancelledError as unknown as new () => Error)
  await settle()
  t.is(getRequestRegistry().cancel({ requestId: 'rerank-queue-cancelled' }), 1)
  await failure
  t.is(model.starts.length, 1)
  t.is(model.cancelled(), 0)
  t.absent(getRequestRegistry().get('rerank-queue-cancelled'))
  model.finish()
  t.alike((await first).scores, scores)
})

test('rerank bounds the waiting queue without interrupting admitted requests', async (t) => {
  let starts = 0
  let finish: () => void = () => {}
  let cancelled = 0
  fixture(
    t,
    'rerank-overflow',
    async () => {
      starts++
      return {
        await: () =>
          starts === 1
            ? new Promise<RerankScores[]>((resolve) => {
                finish = () => resolve([scores])
              })
            : Promise.resolve([scores])
      }
    },
    async () => {
      cancelled++
    }
  )
  const request = { type: 'rerank' as const, modelId: 'rerank-overflow', query, documents }
  const first = rerank(request)
  await settle()
  const queued = Array.from({ length: 64 }, () => rerank(request))
  await t.exception(
    () => rerank(request),
    RequestRejectedByPolicyError as unknown as new () => Error
  )
  t.is(starts, 1)
  t.is(cancelled, 0)
  finish()
  const responses = await Promise.all([first, ...queued])
  t.is(responses.length, 65)
  t.is(starts, 65)
  t.alike(
    responses.map((response) => response.scores),
    Array.from({ length: 65 }, () => scores)
  )
  t.alike((await rerank(request)).scores, scores)
})

test('rerank cancels the owning job, admits the next queued call, and allows recovery', async (t) => {
  let finish: (value: RerankScores[]) => void = () => {}
  let started: () => void = () => {}
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  let cancelled = 0
  fixture(
    t,
    'rerank-cancel',
    async () => ({
      await: () => {
        started()
        return new Promise<RerankScores[]>((resolve) => {
          finish = resolve
        })
      }
    }),
    async () => {
      cancelled++
      finish([scores])
    }
  )
  const request = { type: 'rerank' as const, modelId: 'rerank-cancel', query, documents }
  const first = rerank({ ...request, requestId: 'rerank-cancel-first' })
  const failure = t.exception(() => first, InferenceCancelledError as unknown as new () => Error)
  await running
  const queued = rerank({ ...request, requestId: 'rerank-cancel-next' })
  await settle()
  t.is(cancelled, 0)
  getRequestRegistry().cancel({ requestId: 'rerank-cancel-first' })
  await failure
  t.is(cancelled, 1)
  t.absent(getRequestRegistry().get('rerank-cancel-first'))
  await settle()
  finish([scores])
  t.alike((await queued).scores, scores)
  const recovered = rerank(request)
  await new Promise<void>((resolve) => setTimeout(resolve, 0, undefined))
  finish([scores])
  t.alike((await recovered).scores, scores)
})

test('rerank holds the model slot until pending native cancellation settles', async (t) => {
  let finishOutput: (value: RerankScores[]) => void = () => {}
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
    'rerank-pending-cancel',
    async () => ({
      await: () =>
        new Promise<RerankScores[]>((resolve, reject) => {
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
  const request = { type: 'rerank' as const, modelId: 'rerank-pending-cancel', query, documents }
  const first = rerank({ ...request, requestId: 'rerank-pending-cancel-first' })
  const failure = t.exception(() => first, InferenceCancelledError as unknown as new () => Error)
  await firstStarted
  const queued = rerank({ ...request, requestId: 'rerank-pending-cancel-next' }).then(
    (response) => ({ scores: response.scores }),
    (error: unknown) => ({ error })
  )
  t.is(getRequestRegistry().cancel({ requestId: 'rerank-pending-cancel-first' }), 1)
  t.is(cancelled, 1)
  // The first job finishes naturally while its cancellation is still pending.
  finishOutput([scores])
  await settle()
  t.is(starts, 1, 'the queued job cannot start while native cancellation is pending')
  finishCancel()
  await failure
  await nextStarted
  finishOutput([scores])
  t.alike(await queued, { scores }, 'the delayed cancellation cannot abort the queued job')
  t.absent(getRequestRegistry().get('rerank-pending-cancel-first'))
  t.absent(getRequestRegistry().get('rerank-pending-cancel-next'))
})

test('rerank cancel-before-begin never starts native work', async (t) => {
  let starts = 0
  fixture(t, 'rerank-pre-cancel', async () => {
    starts++
    return { await: async () => [scores] }
  })
  getRequestRegistry().cancel({ requestId: 'rerank-pre-cancel' })
  await t.exception(
    () =>
      rerank({
        type: 'rerank',
        modelId: 'rerank-pre-cancel',
        requestId: 'rerank-pre-cancel',
        query,
        documents
      }),
    InferenceCancelledError as unknown as new () => Error
  )
  t.is(starts, 0)
})
