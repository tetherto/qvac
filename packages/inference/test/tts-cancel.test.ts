import test from 'brittle'
import Buffer from 'bare-buffer'
import { getRequestRegistry } from '@/runtime/index'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { textToSpeech } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'
import { textToSpeechStream } from '@/plugins/builtin/tts-ggml/ops/text-to-speech-stream'

// Both TTS handlers declare `cancel: { scope: 'model', hard: true }`. The
// runtime only honours that for requests present in the request registry —
// `cancelByModelId` walks it — so these tests pin the halves that make the
// declaration true: the run registers under `kind: 'tts'`, an abort reaches
// the addon's `cancel()`, and — because the addon's cancel only hits a native
// job that is live at that instant — the op keeps re-checking the abort and
// drops everything after it instead of forwarding the rest of the text.

type FakeTtsModel = {
  cancelCalls: number
  runCalls: unknown[]
  release: () => void
  getEngineType: () => string
  cancel: () => Promise<void>
  run: (job: unknown) => Promise<unknown>
  runStreaming: (source: AsyncIterable<string>, options?: unknown) => Promise<unknown>
}

// Emits one chunk immediately, then blocks until `release()`, then emits a
// second chunk. Awaiting the first chunk is what makes these tests
// deterministic: once it arrives the op has certainly finished `begin()` and
// attached its abort listener. `cancel()` deliberately does NOT release the
// gate — the test does — so a lost post-cancel check would show up as the
// second chunk being delivered.
function fakeTtsModel(): FakeTtsModel {
  let released!: () => void
  const gate = new Promise<void>((resolve) => {
    released = resolve
  })

  const iterate = async function* () {
    yield { outputArray: [1, 2, 3], sampleRate: 24000 }
    await gate
    yield { outputArray: [4, 5, 6], sampleRate: 24000 }
  }

  const model: FakeTtsModel = {
    cancelCalls: 0,
    runCalls: [],
    release: () => released(),
    getEngineType: () => 'chatterbox',
    async cancel() {
      model.cancelCalls++
    },
    async run(job) {
      model.runCalls.push(job)
      return { stats: { audioDurationMs: 10 }, iterate }
    },
    async runStreaming(source) {
      // Drain the text source the way the addon's accumulator would, so an
      // abort that ends the source is observable.
      void (async () => {
        for await (const _fragment of source) {
          /* consume */
        }
      })()
      return { stats: { audioDurationMs: 10 }, iterate }
    }
  }

  return model
}

function register(modelId: string, model: FakeTtsModel) {
  registerModel(modelId, {
    model: model as never,
    path: '/tmp/tts.gguf',
    config: { ttsEngine: 'chatterbox' },
    modelType: 'tts-ggml'
  })
}

function startRun(modelId: string, requestId: string) {
  return textToSpeech({
    type: 'textToSpeech',
    modelId,
    requestId,
    inputType: 'text',
    text: 'Hello.',
    stream: true,
    sentenceStream: false
  })
}

test('a model-scoped cancel finds an in-flight TTS run, stops the addon, and drops the rest', async (t) => {
  const modelId = 'tts-cancel-model-scope'
  const model = fakeTtsModel()
  register(modelId, model)

  try {
    const stream = startRun(modelId, 'req-model-scope')
    const first = await stream.next()
    t.alike(first.value, { buffer: [1, 2, 3], sampleRate: 24000 }, 'run is live')

    const cancelled = getRequestRegistry().cancel({ modelId, kind: 'tts' })
    t.is(cancelled, 1, 'the in-flight run must be visible to a model-scoped cancel')
    t.is(model.cancelCalls, 1, 'abort must reach the addon cancel()')

    // Let the fake produce its second chunk: the op must swallow it (re-issuing
    // the cancel for the now-live job) rather than forward it.
    model.release()
    const after = await stream.next()
    t.is(after.done, true, 'nothing is delivered after the cancel')
    t.ok(model.cancelCalls >= 2, 'the abort is re-applied on the next chunk')
    t.alike(
      (after.value as { cancelled?: boolean }).cancelled,
      true,
      'the run reports itself cancelled'
    )
    t.is(getRequestRegistry().get('req-model-scope'), null, 'registry entry released')
  } finally {
    unregisterModel(modelId)
  }
})

test('a cancel targeted by requestId stops the matching TTS run', async (t) => {
  const modelId = 'tts-cancel-by-request-id'
  const requestId = 'req-by-id'
  const model = fakeTtsModel()
  register(modelId, model)

  try {
    const stream = startRun(modelId, requestId)
    await stream.next()

    // The id the SDK client surfaces on the result is the id the engine
    // registered under, so `cancel({ requestId })` reaches this exact run.
    const cancelled = getRequestRegistry().cancel({ requestId })
    t.is(cancelled, 1)
    t.is(model.cancelCalls, 1)

    model.release()
    const after = await stream.next()
    t.is(after.done, true)
  } finally {
    unregisterModel(modelId)
  }
})

test('a run that completes normally reports completed, not cancelled', async (t) => {
  const modelId = 'tts-cancel-none'
  const model = fakeTtsModel()
  register(modelId, model)

  try {
    const stream = startRun(modelId, 'req-none')
    await stream.next()
    model.release()
    const second = await stream.next()
    t.alike(second.value, { buffer: [4, 5, 6], sampleRate: 24000 })
    const end = await stream.next()
    t.is(end.done, true)
    t.is((end.value as { cancelled?: boolean }).cancelled, undefined)
    t.is(model.cancelCalls, 0)
  } finally {
    unregisterModel(modelId)
  }
})

test('the tts policy admits one run per model and cancels a queued run before it starts', async (t) => {
  const modelId = 'tts-cancel-queued'
  const model = fakeTtsModel()
  register(modelId, model)

  try {
    const active = startRun(modelId, 'req-active')
    await active.next()

    const queued = startRun(modelId, 'req-queued')
    const queuedFirst = queued.next()
    const settled = await Promise.race([
      queuedFirst.then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 20))
    ])
    t.is(settled, 'pending', 'the second run waits for the model slot')

    // Cancelling the queued run must not touch the addon: it never owned the
    // slot, and a cancel there would interrupt the active run instead.
    t.is(getRequestRegistry().cancel({ requestId: 'req-queued' }), 1)
    t.is(model.cancelCalls, 0, 'queued cancel never reaches the addon')

    model.release()
    await active.next()
    await active.return(undefined as never)

    const queuedResult = await queuedFirst
    t.is(queuedResult.done, true, 'the queued run ends without synthesising')
    t.is((queuedResult.value as { cancelled?: boolean }).cancelled, true)
    t.is(model.runCalls.length, 1, 'only the active run reached the addon')
  } finally {
    unregisterModel(modelId)
  }
})

test('cancelling a duplex session ends it and reaches the addon', async (t) => {
  const modelId = 'tts-cancel-duplex'
  const requestId = 'req-duplex'
  const model = fakeTtsModel()
  register(modelId, model)

  try {
    // A text source that never ends on its own — the idle-session case.
    let endInput!: () => void
    const inputEnded = new Promise<void>((resolve) => {
      endInput = resolve
    })
    const input = (async function* () {
      yield Buffer.from('Hello.')
      await inputEnded
    })()

    const stream = textToSpeechStream(
      { type: 'textToSpeechStream', modelId, requestId, inputType: 'text' },
      input
    )
    const first = await stream.next()
    t.alike(first.value, { buffer: [1, 2, 3], sampleRate: 24000 })

    t.is(getRequestRegistry().cancel({ requestId }), 1)
    t.is(model.cancelCalls, 1, 'duplex cancel reaches the addon')

    model.release()
    const after = await stream.next()
    t.is(after.done, true, 'nothing is delivered after the cancel')
    t.is((after.value as { cancelled?: boolean }).cancelled, true)
    t.is(
      getRequestRegistry().get(requestId),
      null,
      'the slot is released without waiting for input'
    )
    endInput()
  } finally {
    unregisterModel(modelId)
  }
})

test('the plain stream path sends the job the addon expects', async (t) => {
  const modelId = 'tts-run-job'
  const model = fakeTtsModel()
  register(modelId, model)

  try {
    const stream = textToSpeech({
      type: 'textToSpeech',
      modelId,
      inputType: 'text',
      text: 'Hello.',
      stream: true,
      sentenceStream: false,
      sentenceStreamLocale: 'ja',
      sentenceStreamMaxChunkScalars: 4000
    })
    await stream.next()
    model.release()
    await stream.next()
    await stream.next()

    const job = model.runCalls[0] as Record<string, unknown>
    t.is(job['type'], 'text', 'the native layer accepts only text; the job pins it')
    t.is(job['inputType'], undefined, 'the request field name never reaches the addon')
    t.is(job['streamOutput'], true)
    // run({ streamOutput: true }) runs the same chunker as runStream(), so the
    // chunking knobs must ride the plain streaming path too.
    t.is(job['locale'], 'ja')
    t.is(job['maxChunkScalars'], 4000)
  } finally {
    unregisterModel(modelId)
  }
})
