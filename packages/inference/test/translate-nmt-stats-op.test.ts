import test from 'brittle'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { ModelType, type TranslationStats } from '@/schemas'
import { translate } from '@/plugins/ops/translate'
import type { AnyModel } from '@/runtime/model-registry'

let idCounter = 0
function makeId(prefix: string): string {
  idCounter++
  return `${prefix}-${idCounter}`
}

// Stands in for the nmtcpp addon: every job adds 10 tokens and 24 ms to the
// model's lifetime counters, and a response reports the counters as they stand.
function registerNmt(modelId: string) {
  let totalTokens = 0
  let totalTime = 0
  function advance(jobs: number) {
    totalTokens += 10 * jobs
    totalTime += 0.024 * jobs
  }
  const model = {
    run: async (input: string) => {
      advance(1)
      const stats = { totalTokens, totalTime, decodeTime: totalTime, TPS: totalTokens / totalTime }
      return {
        stats,
        await: async () => [`[${input}]`],
        iterate: async function* () {
          yield `[${input}]`
        },
        cancel: async () => {}
      }
    },
    runBatch: async (texts: string[]) => {
      advance(texts.length)
      return texts.map((text) => `[${text}]`)
    }
  }
  registerModel(modelId, {
    model: model as unknown as AnyModel,
    path: `/tmp/${modelId}.bin`,
    config: {},
    modelType: ModelType.nmtcppTranslation
  })
}

function start(modelId: string, text: string | string[]) {
  return translate(
    { modelId, text, stream: true, modelType: ModelType.nmtcppTranslation } as never,
    makeId('req')
  )
}

async function finish(gen: ReturnType<typeof start>) {
  const tokens: string[] = []
  let next = await gen.next()
  while (!next.done) {
    tokens.push(next.value)
    next = await gen.next()
  }
  return { tokens, stats: next.value.stats as TranslationStats | undefined }
}

test('translate (NMT): consecutive requests report their own figures', async (t) => {
  const modelId = makeId('nmt-stats')
  registerNmt(modelId)

  const first = await finish(start(modelId, 'one'))
  const second = await finish(start(modelId, 'two'))
  const third = await finish(start(modelId, 'three'))

  t.alike(second.tokens, ['[two]'])
  t.is(first.stats?.totalTokens, 10)
  t.is(second.stats?.totalTokens, 10, 'not the running total of 20')
  t.is(third.stats?.totalTokens, 10, 'not the running total of 30')
  t.ok(Math.abs(third.stats!.totalTime! - 24) < 1e-9, 'time is per request, in ms')
  t.ok(Math.abs(third.stats!.tokensPerSecond! - 10 / 0.024) < 1e-6, 'rate is per request')

  unregisterModel(modelId)
})

test('translate (NMT): the single request after a batch reports no counters', async (t) => {
  const modelId = makeId('nmt-stats-batch')
  registerNmt(modelId)

  await finish(start(modelId, 'one'))
  const batch = await finish(start(modelId, ['a', 'b', 'c']))
  const afterBatch = await finish(start(modelId, 'two'))
  const next = await finish(start(modelId, 'three'))

  t.alike(batch.tokens, ['[a]', '[b]', '[c]'])
  t.absent(batch.stats, 'a batch reports no stats')
  t.absent(
    afterBatch.stats?.totalTokens,
    "the batch's 30 tokens are not attributed to this request"
  )
  t.absent(afterBatch.stats?.tokensPerSecond)
  t.is(next.stats?.totalTokens, 10, 'differencing resumes from the post-batch reading')

  unregisterModel(modelId)
})

test('translate (NMT): a slow consumer does not let a peer request shift the baseline', async (t) => {
  const modelId = makeId('nmt-stats-order')
  registerNmt(modelId)

  await finish(start(modelId, 'warm-up'))

  // A's job has ended and its token is out, but A's consumer has not asked for
  // the end of the stream yet when B runs start to finish.
  const genA = start(modelId, 'a')
  const tokenA = await genA.next()
  const b = await finish(start(modelId, 'b'))
  const doneA = await genA.next()
  const resultA = doneA.value as { stats?: TranslationStats }

  t.is(tokenA.value, '[a]')
  t.ok(doneA.done)
  t.is(resultA.stats?.totalTokens, 10, "A reports its own work, not the model's total of 20")
  t.is(b.stats?.totalTokens, 10, "B does not absorb A's work")

  unregisterModel(modelId)
})
