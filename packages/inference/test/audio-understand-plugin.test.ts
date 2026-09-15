import test from 'brittle'
import { AudioGen } from '@qvac/audiogen-ggml'
import type {
  AudiogenOutputChunk,
  AudiogenStats,
  AudiogenUnderstandResult,
  UnderstandOptions
} from '@qvac/audiogen-ggml'
import { audioUnderstand } from '@/plugins/builtin/audiogen-ggml/ops/audio-understand'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/index'
import { ModelType } from '@/schemas/index'
import { InvalidAudioInputError, ModelOperationNotSupportedError } from '@/errors/index'

type AudioGenResponse = Awaited<ReturnType<AudioGen['run']>>

interface RecordedCall {
  audio: Float32Array
  options: UnderstandOptions | undefined
}

/** The recovered codes the addon hands over: an `Int32Array`, never a plain array. */
const RECOVERED_CODES = new Int32Array([7, -3, 2048])

function understandResult(
  overrides: Partial<AudiogenUnderstandResult> = {}
): AudiogenUnderstandResult {
  return {
    caption: 'downtempo synthwave with a breathy vocal',
    bpm: 96,
    duration: 12.5,
    keyscale: 'F minor',
    timesignature: '4/4',
    vocalLanguage: 'en',
    audioCodes: RECOVERED_CODES,
    ...overrides
  }
}

function createResponse(chunks: AudiogenOutputChunk[], stats: AudiogenStats): AudioGenResponse {
  return {
    async *iterate() {
      for (const chunk of chunks) yield chunk
    },
    async await() {
      return stats
    }
  } as unknown as AudioGenResponse
}

/** An AudioGen whose `understand()` records its arguments and resolves `response`. */
function createUnderstandModel(
  response: AudioGenResponse,
  calls: RecordedCall[],
  hooks: { onCancel?: () => void; onUnderstand?: () => void } = {}
) {
  const model = new AudioGen({
    files: {
      textEncModel: 'text-encoder.gguf',
      lmModel: 'lm.gguf',
      ditModel: 'dit.gguf',
      vaeModel: 'vae.gguf'
    }
  })
  model.understand = async function (audio: Float32Array, options?: UnderstandOptions) {
    hooks.onUnderstand?.()
    calls.push({ audio, options })
    return response
  }
  model.cancel = async function () {
    hooks.onCancel?.()
  }
  return model
}

function registerAudioGenModel(modelId: string, model: AudioGen) {
  registerModel(modelId, {
    model: model as unknown as AnyModel,
    path: '',
    config: {},
    modelType: ModelType.audiogenGgml
  })
}

function stereoFloat32Base64(samples: number[]) {
  const pcm = new Float32Array(samples)
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

test('audioUnderstand rejects a model from another plugin', async (t) => {
  const modelId = 'audio-understand-wrong-model'
  registerModel(modelId, {
    model: {} as AnyModel,
    path: '',
    config: {},
    modelType: ModelType.llamacppCompletion
  })
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const stream = audioUnderstand({
    type: 'audioUnderstand',
    requestId: 'audio-understand-request-wrong-model',
    modelId,
    sourceAudio: { type: 'base64', value: stereoFloat32Base64([0.1, -0.1]) }
  })

  const error = await rejection(stream.next())
  t.ok(error instanceof ModelOperationNotSupportedError)
  t.is((error as ModelOperationNotSupportedError).operation, 'audioUnderstand')
  t.is(getRequestRegistry().get('audio-understand-request-wrong-model'), null)
})

test('audioUnderstand streams the description and repeats it on the terminal stats', async (t) => {
  const modelId = 'audio-understand-success'
  const requestId = 'audio-understand-request-success'
  const calls: RecordedCall[] = []
  const model = createUnderstandModel(
    createResponse(
      [{ progress: { stage: 'lm', step: 2, total: 4 } }, { understand: understandResult() }],
      {
        audioDurationMs: 12_500,
        totalTimeMs: 4_000,
        realTimeFactor: 0.32,
        backendDevice: 1,
        backendId: 1,
        understand: understandResult()
      }
    ),
    calls
  )
  registerAudioGenModel(modelId, model)
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const frames = []
  for await (const frame of audioUnderstand({
    type: 'audioUnderstand',
    requestId,
    modelId,
    sourceAudio: { type: 'base64', value: stereoFloat32Base64([0.5, -0.5, 0.25, -0.25]) },
    seed: 11,
    vocalLanguage: 'es',
    lmTemperature: 0.7,
    lmTopP: 0.85,
    lmTopK: 40
  })) {
    frames.push(frame)
  }

  t.is(calls.length, 1, 'one understand call per request')
  const call = calls[0]!
  t.ok(call.audio instanceof Float32Array)
  t.alike(Array.from(call.audio), [0.5, -0.5, 0.25, -0.25], 'the decoded source PCM is forwarded')
  t.alike(call.options, {
    seed: 11,
    vocalLanguage: 'es',
    lmTemperature: 0.7,
    lmTopP: 0.85,
    lmTopK: 40
  })

  t.is(frames.length, 3, 'progress, description, terminal')
  t.alike(frames[0], {
    type: 'audioUnderstand',
    progress: { stage: 'lm', step: 2, total: 4 },
    done: false
  })

  const streamed = frames[1]!
  t.is(streamed.done, false)
  t.is(streamed.understand?.caption, 'downtempo synthwave with a breathy vocal')
  t.ok(
    Array.isArray(streamed.understand?.audioCodes),
    'the Int32Array the addon returns is normalized to a plain array'
  )
  t.alike(streamed.understand?.audioCodes, [7, -3, 2048])

  const terminal = frames[2]!
  t.is(terminal.done, true)
  t.is(terminal.stopReason, 'completed')
  t.alike(terminal.stats?.understand?.audioCodes, [7, -3, 2048])
  t.is(terminal.stats?.understand?.bpm, 96)
  t.is(terminal.stats?.audioDurationMs, 12_500)
  t.alike(terminal.diagnostics, {
    selectedBackend: 'metal',
    selectedDevice: 'gpu',
    graphicsApi: 'metal'
  })
  t.is(getRequestRegistry().get(requestId), null, 'the request slot is released')
})

test('audioUnderstand rejects source audio the addon cannot accept', async (t) => {
  const modelId = 'audio-understand-bad-input'
  const calls: RecordedCall[] = []
  const model = createUnderstandModel(
    createResponse([{ understand: understandResult() }], {}),
    calls
  )
  registerAudioGenModel(modelId, model)
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const stream = audioUnderstand({
    type: 'audioUnderstand',
    requestId: 'audio-understand-request-bad-input',
    modelId,
    // Non-finite is what the engine rejects here: `understand()` vets its audio
    // with `requireFinitePcm`, so a sample above 1.0 is its business, not ours.
    sourceAudio: { type: 'base64', value: stereoFloat32Base64([Number.NaN, -0.5]) }
  })

  const error = await rejection(stream.next())
  t.ok(error instanceof InvalidAudioInputError)
  t.is(calls.length, 0, 'the native job is never admitted')
  t.is(getRequestRegistry().get('audio-understand-request-bad-input'), null)
})

test('audioUnderstand passes a hot source through to the engine', async (t) => {
  const modelId = 'audio-understand-hot-input'
  const calls: RecordedCall[] = []
  const model = createUnderstandModel(
    createResponse([{ understand: understandResult() }], {}),
    calls
  )
  registerAudioGenModel(modelId, model)
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const stream = audioUnderstand({
    type: 'audioUnderstand',
    requestId: 'audio-understand-request-hot-input',
    modelId,
    sourceAudio: { type: 'base64', value: stereoFloat32Base64([1.5, -0.5]) }
  })

  for await (const _frame of stream) void _frame
  t.is(calls.length, 1, 'a sample above 1.0 reaches the engine, as the addon allows')
})

test('audioUnderstand cancels the native job and terminates as cancelled', async (t) => {
  const modelId = 'audio-understand-cancel'
  const requestId = 'audio-understand-request-cancel'
  const calls: RecordedCall[] = []
  let cancelled = 0
  const model = createUnderstandModel(
    createResponse(
      [{ progress: { stage: 'lm', step: 1, total: 4 } }, { understand: understandResult() }],
      { understand: understandResult() }
    ),
    calls,
    {
      onCancel: () => {
        cancelled++
      }
    }
  )
  registerAudioGenModel(modelId, model)
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const stream = audioUnderstand({
    type: 'audioUnderstand',
    requestId,
    modelId,
    sourceAudio: { type: 'base64', value: stereoFloat32Base64([0.1, -0.1]) }
  })
  const first = await stream.next()
  t.is(first.value?.progress?.step, 1)
  t.is(getRequestRegistry().cancel({ requestId }), 1)

  const terminal = await stream.next()
  t.alike(
    terminal.value,
    { type: 'audioUnderstand', done: true, stopReason: 'cancelled' },
    'a cancelled run terminates without a description or stats'
  )
  t.is(cancelled, 1, 'the model-scoped cancel runs once')

  const completed = await stream.next()
  t.ok(completed.done)
  t.is(getRequestRegistry().get(requestId), null)
})
