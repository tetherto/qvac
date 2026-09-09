import test from 'brittle'
import { getRequestRegistry } from '@/runtime/index'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { textToSpeech } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'

// Both TTS handlers declare `cancel: { scope: 'model', hard: true }`. The
// runtime only honours that for requests present in the request registry —
// `cancelByModelId` walks it — so these tests pin the two halves that make the
// declaration true: the run registers under `kind: 'tts'`, and an abort reaches
// the addon's `cancel()`.

type FakeTtsModel = {
  cancelCalls: number
  release: () => void
  getEngineType: () => string
  cancel: () => Promise<void>
  run: () => Promise<unknown>
}

// Emits one chunk immediately, then blocks until `release()`. Awaiting the
// first chunk is what makes these tests deterministic: once it arrives the op
// has certainly finished `begin()` and attached its abort listener.
function fakeTtsModel(): FakeTtsModel {
  let released!: () => void
  const gate = new Promise<void>((resolve) => {
    released = resolve
  })

  const model: FakeTtsModel = {
    cancelCalls: 0,
    release: () => released(),
    getEngineType: () => 'chatterbox',
    async cancel() {
      model.cancelCalls++
      released()
    },
    async run() {
      return {
        stats: { audioDurationMs: 10 },
        async *iterate() {
          yield { outputArray: [1, 2, 3], sampleRate: 24000 }
          await gate
          yield { outputArray: [4, 5, 6], sampleRate: 24000 }
        }
      }
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

test('a model-scoped cancel finds an in-flight TTS run and stops the addon', async (t) => {
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

    await stream.return(undefined as never)
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

    await stream.return(undefined as never)
  } finally {
    unregisterModel(modelId)
  }
})
