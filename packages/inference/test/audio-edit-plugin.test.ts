import test from 'brittle'
import { AudioGen, RepaintMode } from '@qvac/audiogen-ggml'
import type {
  AudioEditRunOptions,
  AudioEditSession,
  AudioEditSource,
  AudiogenOutputChunk,
  AudiogenStats,
  FlowEditOptions,
  RepaintOptions
} from '@qvac/audiogen-ggml'
import { audioEditStream } from '@/plugins/builtin/audiogen-ggml/ops/audio-edit-stream'
import { assertNormalizedPcm } from '@/plugins/builtin/audiogen-ggml/ops/audio-gen-input'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/index'
import { ModelType } from '@/schemas/index'
import { readBackendDiagnostics } from '@/profiling/backend-diagnostics'
import { InvalidAudioInputError, ModelOperationNotSupportedError } from '@/errors/index'

type AudioGenResponse = Awaited<ReturnType<AudioGen['run']>>

type RecordedOperation =
  { kind: 'flowEdit'; options: FlowEditOptions } | { kind: 'repaint'; options: RepaintOptions }

interface RecordedSession {
  source: AudioEditSource
  operations: RecordedOperation[]
  runOptions?: AudioEditRunOptions | undefined
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

/**
 * An AudioGen whose `edit()` records the source and every chained operation
 * instead of touching the native engine; `run()` resolves `response`.
 */
function createEditModel(
  response: AudioGenResponse,
  sessions: RecordedSession[],
  hooks: { onCancel?: () => void; onFlowEdit?: (options: FlowEditOptions) => void } = {}
) {
  const model = new AudioGen({
    files: {
      textEncModel: 'text-encoder.gguf',
      lmModel: 'lm.gguf',
      ditModel: 'dit.gguf',
      vaeModel: 'vae.gguf'
    }
  })
  model.edit = function (source: AudioEditSource) {
    const record: RecordedSession = { source, operations: [] }
    sessions.push(record)
    const session = {
      flowEdit(options: FlowEditOptions) {
        hooks.onFlowEdit?.(options)
        record.operations.push({ kind: 'flowEdit', options })
        return session
      },
      edit(options: FlowEditOptions) {
        return session.flowEdit(options)
      },
      repaint(options: RepaintOptions) {
        record.operations.push({ kind: 'repaint', options })
        return session
      },
      async run(options?: AudioEditRunOptions) {
        record.runOptions = options
        return response
      }
    }
    return session as unknown as AudioEditSession
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

test('audioEdit plugin operation rejects a model from another plugin', async (t) => {
  const modelId = 'audio-edit-operation-wrong-model'
  registerModel(modelId, {
    model: {} as AnyModel,
    path: '',
    config: {},
    modelType: ModelType.llamacppCompletion
  })
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const stream = audioEditStream({
    type: 'audioEditStream',
    requestId: 'audio-edit-request-wrong-model',
    modelId,
    sourceAudio: { type: 'base64', value: stereoFloat32Base64([0.1, -0.1]) },
    operations: [{ type: 'repaint', caption: 'analog synth solo', start: 0 }]
  })

  const error = await rejection(stream.next())
  t.ok(error instanceof ModelOperationNotSupportedError)
  t.is((error as ModelOperationNotSupportedError).operation, 'audioEditStream')
  t.is(getRequestRegistry().get('audio-edit-request-wrong-model'), null)
})

test('audioEdit plugin operation chains operations in order and streams the edited audio', async (t) => {
  const modelId = 'audio-edit-operation-success'
  const requestId = 'audio-edit-request-success'
  const sessions: RecordedSession[] = []
  const model = createEditModel(
    createResponse(
      [
        { progress: { stage: 'dit', step: 1, total: 8 } },
        { outputArray: new Int16Array([1, -1]), sampleRate: 48000, channels: 2 }
      ],
      { audioDurationMs: 10, totalTimeMs: 5, realTimeFactor: 0.5, backendDevice: 1, backendId: 1 }
    ),
    sessions
  )
  registerAudioGenModel(modelId, model)
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const frames = []
  for await (const frame of audioEditStream({
    type: 'audioEditStream',
    requestId,
    modelId,
    sourceAudio: { type: 'base64', value: stereoFloat32Base64([0.5, -0.5, 0.25, -0.25]) },
    seed: 7,
    operations: [
      {
        type: 'flow-edit',
        from: { caption: 'original pop song', lyrics: 'la la la' },
        to: { caption: 'guitar pop-rock' },
        nMin: 0.2,
        nMax: 0.9,
        nAvg: 3
      },
      {
        type: 'repaint',
        caption: 'analog synth solo',
        lyrics: '[Instrumental]',
        start: 0.5,
        end: 1.5,
        mode: 'aggressive',
        strength: 0.25
      },
      {
        type: 'flow-edit',
        from: { caption: 'guitar pop-rock' },
        to: { caption: 'dark synthwave' }
      }
    ]
  })) {
    frames.push(frame)
  }

  t.is(sessions.length, 1, 'one edit session per request')
  const session = sessions[0]!
  t.ok(session.source.pcm instanceof Float32Array)
  t.alike(Array.from(session.source.pcm), [0.5, -0.5, 0.25, -0.25])
  t.is(session.source.sampleRate, 48000)
  t.is(session.source.channels, 2)
  t.alike(session.operations, [
    {
      kind: 'flowEdit',
      options: {
        from: { caption: 'original pop song', lyrics: 'la la la' },
        to: { caption: 'guitar pop-rock' },
        nMin: 0.2,
        nMax: 0.9,
        nAvg: 3
      }
    },
    {
      kind: 'repaint',
      options: {
        caption: 'analog synth solo',
        lyrics: '[Instrumental]',
        start: 0.5,
        end: 1.5,
        mode: RepaintMode.Aggressive,
        strength: 0.25
      }
    },
    {
      kind: 'flowEdit',
      options: { from: { caption: 'guitar pop-rock' }, to: { caption: 'dark synthwave' } }
    }
  ])
  t.alike(session.runOptions, { seed: 7 })

  t.alike(frames[0], {
    type: 'audioEditStream',
    progress: { stage: 'dit', step: 1, total: 8 },
    done: false
  })
  t.is(frames[1]?.type, 'audioEditStream')
  t.is(frames[1]?.sampleRate, 48000)
  t.is(frames[1]?.channels, 2)
  t.is(frames[1]?.bitsPerSample, 16)
  t.ok(frames[1]?.data !== undefined)
  t.is(frames[2]?.done, true)
  t.is(frames[2]?.stopReason, 'completed')
  t.alike(frames[2]?.stats, {
    audioDurationMs: 10,
    totalTimeMs: 5,
    realTimeFactor: 0.5,
    backendDevice: 1,
    backendId: 1
  })
  t.alike(frames[2]?.diagnostics, {
    selectedBackend: 'metal',
    selectedDevice: 'gpu',
    graphicsApi: 'metal'
  })
  t.alike(readBackendDiagnostics(frames[2]), frames[2]?.diagnostics)
  t.is(getRequestRegistry().get(requestId), null)
})

test('audioEdit plugin operation omits unset operation fields from the addon call', async (t) => {
  const modelId = 'audio-edit-operation-defaults'
  const requestId = 'audio-edit-request-defaults'
  const sessions: RecordedSession[] = []
  const model = createEditModel(
    createResponse([{ outputArray: new Int16Array([0, 0]), sampleRate: 48000, channels: 2 }], {}),
    sessions
  )
  registerAudioGenModel(modelId, model)
  t.teardown(() => {
    unregisterModel(modelId)
  })

  for await (const frame of audioEditStream({
    type: 'audioEditStream',
    requestId,
    modelId,
    sourceAudio: { type: 'base64', value: stereoFloat32Base64([0.1, -0.1]) },
    operations: [
      { type: 'flow-edit', from: { caption: 'acoustic folk' }, to: { caption: 'synthwave' } },
      { type: 'repaint', caption: 'drum fill', start: 0 }
    ]
  })) {
    void frame
  }

  t.alike(sessions[0]?.operations, [
    {
      kind: 'flowEdit',
      options: { from: { caption: 'acoustic folk' }, to: { caption: 'synthwave' } }
    },
    { kind: 'repaint', options: { caption: 'drum fill', start: 0 } }
  ])
  t.alike(sessions[0]?.runOptions, {}, 'the addon applies its own defaults, including the seed')
  t.is(getRequestRegistry().get(requestId), null)
})

test('audioEdit plugin operation rejects out-of-range source PCM before touching the addon', async (t) => {
  const modelId = 'audio-edit-operation-unnormalized'
  const requestId = 'audio-edit-request-unnormalized'
  const sessions: RecordedSession[] = []
  const model = createEditModel(createResponse([], {}), sessions)
  registerAudioGenModel(modelId, model)
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const stream = audioEditStream({
    type: 'audioEditStream',
    requestId,
    modelId,
    sourceAudio: { type: 'base64', value: stereoFloat32Base64([0.5, 1.5]) },
    operations: [{ type: 'repaint', caption: 'drum fill', start: 0 }]
  })
  const error = await rejection(stream.next())
  t.ok(error instanceof InvalidAudioInputError)
  t.ok(/\[-1, 1\]/.test((error as Error).message))
  t.is(sessions.length, 0, 'no edit session was opened')
  t.is(getRequestRegistry().get(requestId), null)
})

test('audioEdit plugin operation surfaces addon validation errors as the request error', async (t) => {
  const modelId = 'audio-edit-operation-addon-rejects'
  const requestId = 'audio-edit-request-addon-rejects'
  const sessions: RecordedSession[] = []
  const rejected = new Error(
    'flowEdit is supported on turbo DiT variants only (turbo-q4, turbo-q8)'
  )
  const model = createEditModel(createResponse([], {}), sessions, {
    onFlowEdit() {
      throw rejected
    }
  })
  registerAudioGenModel(modelId, model)
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const stream = audioEditStream({
    type: 'audioEditStream',
    requestId,
    modelId,
    sourceAudio: { type: 'base64', value: stereoFloat32Base64([0.1, -0.1]) },
    operations: [{ type: 'flow-edit', from: { caption: 'a' }, to: { caption: 'b' } }]
  })
  const error = await rejection(stream.next())
  t.is(error, rejected)
  t.is(sessions[0]?.runOptions, undefined, 'the pipeline never ran')
  t.is(getRequestRegistry().get(requestId), null)
})

test('audioEdit plugin operation hard-cancels and frees its registry entry', async (t) => {
  const modelId = 'audio-edit-operation-cancel'
  const requestId = 'audio-edit-request-cancel'
  let cancelCalls = 0
  const model = createEditModel(
    createResponse(
      [
        { progress: { stage: 'dit', step: 1, total: 2 } },
        { progress: { stage: 'dit', step: 2, total: 2 } }
      ],
      {}
    ),
    [],
    {
      onCancel() {
        cancelCalls++
      }
    }
  )
  registerAudioGenModel(modelId, model)
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const stream = audioEditStream({
    type: 'audioEditStream',
    requestId,
    modelId,
    sourceAudio: { type: 'base64', value: stereoFloat32Base64([0.1, -0.1]) },
    operations: [{ type: 'repaint', caption: 'drum fill', start: 0 }]
  })
  const first = await stream.next()
  t.is(first.value?.progress?.step, 1)
  t.is(getRequestRegistry().cancel({ modelId, kind: 'audiogen' }), 1, 'edits are audiogen work')

  const cancelled = await stream.next()
  t.alike(cancelled.value, { type: 'audioEditStream', done: true, stopReason: 'cancelled' })
  t.is(cancelCalls, 1)
  t.ok((await stream.next()).done)
  t.is(getRequestRegistry().get(requestId), null)
})

test('assertNormalizedPcm accepts the closed [-1, 1] range and rejects anything outside', (t) => {
  t.execution(() => assertNormalizedPcm(new Float32Array([-1, 1, 0, 0.5]), 'sourceAudio'))
  t.exception(
    () => assertNormalizedPcm(new Float32Array([0, 1.0001]), 'sourceAudio'),
    /sourceAudio must contain samples in \[-1, 1\]/
  )
  t.exception(() => assertNormalizedPcm(new Float32Array([-1.5, 0]), 'sourceAudio'), /\[-1, 1\]/)
})
